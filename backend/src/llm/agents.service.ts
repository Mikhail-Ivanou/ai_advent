import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Agent, AgentAskResult, CompressionSettings } from './agent';
import { AskOptions, ChatMessage, ReasoningMode } from './llm.client';

const STORE_PATH = path.join(process.cwd(), 'data', 'agents.json');

interface StoredAgent {
  history: ChatMessage[];
  summary: string;
  summarizedThroughIndex: number;
}

/**
 * Keeps one Agent per chat id alive in memory and mirrors its conversation
 * history to disk, so a chat's context survives a backend restart: on boot
 * we read the store back in, and after every turn we write it out again.
 */
@Injectable()
export class AgentsService implements OnModuleInit {
  private readonly logger = new Logger(AgentsService.name);
  private readonly agents = new Map<string, Agent>();

  async onModuleInit() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      const stored: Record<string, ChatMessage[] | StoredAgent> = JSON.parse(raw);
      for (const [id, entry] of Object.entries(stored)) {
        // Older stores kept a bare message array per chat — treat that as history with no summary yet.
        const { history, summary, summarizedThroughIndex } = Array.isArray(entry)
          ? { history: entry, summary: '', summarizedThroughIndex: 0 }
          : entry;
        this.agents.set(id, new Agent(id, history, summary, summarizedThroughIndex));
      }
      this.logger.log(`Restored ${this.agents.size} agent(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read agent store: ${(error as Error).message}`);
      }
    }
  }

  async ask(
    id: string,
    prompt: string,
    reasoningMode?: ReasoningMode,
    options?: AskOptions,
    compression?: CompressionSettings,
  ): Promise<AgentAskResult> {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = new Agent(id);
      this.agents.set(id, agent);
    }

    const result = await agent.ask(prompt, reasoningMode, options, compression);
    await this.persist();
    return result;
  }

  getHistory(id: string): ChatMessage[] {
    return this.agents.get(id)?.history ?? [];
  }

  async delete(id: string): Promise<void> {
    this.agents.delete(id);
    await this.persist();
  }

  // Serializes the actual disk writes: two `ask()` calls for different chats
  // can both finish around the same time, and since each snapshot is the
  // full in-memory map, an out-of-order write would silently clobber the
  // other chat's latest turn. Chaining onto this queue keeps writes in the
  // same order the snapshots were taken, so the newest one always lands last.
  private writeQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    // Snapshot synchronously, right now — before any await lets another
    // request's mutation or write interleave.
    const snapshot: Record<string, StoredAgent> = {};
    for (const [id, agent] of this.agents) {
      snapshot[id] = {
        history: agent.history,
        summary: agent.summary,
        summarizedThroughIndex: agent.summarizedThroughIndex,
      };
    }

    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    };

    // Run after the previous write regardless of whether it succeeded, so one
    // failed write doesn't permanently wedge the queue; `current` still lets
    // this call's own caller see this write's own success/failure.
    const current = this.writeQueue.then(writeSnapshot, writeSnapshot);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
