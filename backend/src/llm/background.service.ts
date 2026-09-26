import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { McpService } from '../mcp/mcp.service';
import { McpServerView, chatMeta } from '../mcp/mcp.types';
import { AgentsService } from './agents.service';

const STORE_PATH = path.join(process.cwd(), 'data', 'background.json');
const POLL_MS = Number(process.env.BACKGROUND_POLL_MS ?? 20_000);
/** A page asking for fresh data triggers a poll, but no more often than this. */
const MIN_POLL_GAP_MS = 5_000;
const MAX_EVENTS_PER_CHAT = 200;

// Tool names of the scheduler convention (implemented by mcp-weather) — any
// connected server exposing them takes part, no server is special-cased.
const EVENTS_TOOL = 'get_task_events';
const LIST_TOOL = 'list_scheduled_tasks';
const STATUS_TOOL = 'set_task_status';
const SUMMARY_TOOL = 'get_task_summary';

export interface BackgroundEvent {
  /** Our own monotonic id — the page remembers the last one it rendered. */
  id: number;
  serverId: string;
  serverName: string;
  taskId: string;
  taskTitle: string;
  type: string;
  text: string;
  createdAt: string;
}

export interface BackgroundTask {
  serverId: string;
  serverName: string;
  [key: string]: unknown;
}

interface StoreShape {
  /** Last event seq seen per server (keyed by id + url, so repointing a server starts over). */
  cursors: Record<string, number>;
  nextId: number;
  inbox: Record<string, BackgroundEvent[]>;
}

/**
 * Background tasks (Day 18): the scheduling itself happens on the MCP server
 * (24/7, on the VM); this side only collects what the tasks produced and
 * routes each event to the chat that created the task — into that agent's
 * history, and into an inbox the page polls to show it as a message.
 */
@Injectable()
export class BackgroundService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BackgroundService.name);
  private store: StoreShape = { cursors: {}, nextId: 1, inbox: {} };
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private lastPollAt = 0;

  constructor(
    private readonly mcpService: McpService,
    private readonly agentsService: AgentsService,
  ) {}

  async onApplicationBootstrap() {
    try {
      this.store = { ...this.store, ...JSON.parse(await fs.readFile(STORE_PATH, 'utf-8')) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read background store: ${(error as Error).message}`);
      }
    }
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async getState(chatId: string, afterId: number): Promise<{ tasks: BackgroundTask[]; events: BackgroundEvent[] }> {
    if (Date.now() - this.lastPollAt > MIN_POLL_GAP_MS) await this.poll();
    const tasks: BackgroundTask[] = [];
    for (const server of this.serversWith(LIST_TOOL)) {
      const result = await this.mcpService.callTool(server.id, LIST_TOOL, {}, chatMeta(chatId));
      const list = result.structured?.tasks;
      if (Array.isArray(list)) tasks.push(...list.map((t) => ({ ...t, serverId: server.id, serverName: server.name })));
    }
    const events = (this.store.inbox[chatId] ?? []).filter((e) => e.id > afterId);
    return { tasks, events };
  }

  async setStatus(chatId: string, serverId: string, taskId: string, status: string): Promise<string> {
    return this.call(chatId, serverId, STATUS_TOOL, { task_id: taskId, status });
  }

  async summary(chatId: string, serverId: string, taskId: string): Promise<string> {
    return this.call(chatId, serverId, SUMMARY_TOOL, { task_id: taskId });
  }

  private async call(chatId: string, serverId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.mcpService.callTool(serverId, tool, args, chatMeta(chatId));
    if (result.isError) throw new BadRequestException(result.content);
    return result.content;
  }

  private serversWith(tool: string): McpServerView[] {
    return this.mcpService.list().filter((s) => s.status === 'connected' && s.tools.some((t) => t.name === tool));
  }

  /** Single-flight: overlapping callers (timer + page requests) share one poll. */
  private poll(): Promise<void> {
    this.polling ??= this.pollOnce()
      .catch((error) => this.logger.warn(`Background poll failed: ${(error as Error).message}`))
      .finally(() => {
      this.polling = undefined;
      this.lastPollAt = Date.now();
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    let changed = false;
    for (const server of this.serversWith(EVENTS_TOOL)) {
      const cursorKey = `${server.id}|${server.url}`;
      // No `_meta` here on purpose: we want every chat's events, then route each by its owner.
      const result = await this.mcpService.callTool(server.id, EVENTS_TOOL, {
        after_seq: this.store.cursors[cursorKey] ?? 0,
        limit: 200,
      });
      const events = result.structured?.events;
      if (result.isError || !Array.isArray(events) || events.length === 0) continue;

      for (const e of events as Record<string, any>[]) {
        this.store.cursors[cursorKey] = Math.max(this.store.cursors[cursorKey] ?? 0, Number(e.seq) || 0);
        changed = true;
        if (typeof e.ownerId !== 'string') continue;
        const event: BackgroundEvent = {
          id: this.store.nextId++,
          serverId: server.id,
          serverName: server.name,
          taskId: String(e.taskId),
          taskTitle: String(e.taskTitle),
          type: String(e.type),
          text: String(e.text),
          createdAt: String(e.createdAt),
        };
        const inbox = (this.store.inbox[e.ownerId] ??= []);
        inbox.push(event);
        if (inbox.length > MAX_EVENTS_PER_CHAT) inbox.splice(0, inbox.length - MAX_EVENTS_PER_CHAT);
        await this.agentsService.appendAssistantMessage(e.ownerId, `[Фоновая задача «${event.taskTitle}»]\n${event.text}`);
      }
      this.logger.log(`Collected ${events.length} background event(s) from "${server.name}"`);
    }
    if (changed) await this.persist();
  }

  private async persist() {
    try {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn(`Could not save background store: ${(error as Error).message}`);
    }
  }
}
