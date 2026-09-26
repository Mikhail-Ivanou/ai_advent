import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Agent, AgentAskResult, ContextConfig, InvariantConfig, McpConfig, MemoryConfig, TaskConfig } from './agent';
import { AskOptions, ChatMessage, LlmTool, LlmToolset, ReasoningMode } from './llm.client';
import { TaskStage, TaskState } from './task-state';
import { MemoryService } from '../memory/memory.service';
import { ProfileService } from '../profile/profile.service';
import { InvariantService } from '../invariant/invariant.service';
import { McpService } from '../mcp/mcp.service';

const STORE_PATH = path.join(process.cwd(), 'data', 'agents.json');

interface StoredAgentV1 {
  history: ChatMessage[];
  summary: string;
  summarizedThroughIndex: number;
}

interface StoredAgentV2 {
  branches: Record<string, ChatMessage[]>;
  activeBranchId: string;
  summary: string;
  summarizedThroughIndex: number;
  facts: Record<string, string>;
}

interface StoredAgentV3 extends StoredAgentV2 {
  workingMemory: Record<string, string>;
}

interface StoredAgentV4 extends StoredAgentV3 {
  taskState: TaskState | null;
}

type StoredAgent = ChatMessage[] | StoredAgentV1 | StoredAgentV2 | StoredAgentV3 | StoredAgentV4;

function isV2(entry: StoredAgent): entry is StoredAgentV2 | StoredAgentV3 | StoredAgentV4 {
  return !Array.isArray(entry) && 'branches' in entry;
}

function isV3(entry: StoredAgentV2 | StoredAgentV3 | StoredAgentV4): entry is StoredAgentV3 | StoredAgentV4 {
  return 'workingMemory' in entry;
}

function isV4(entry: StoredAgentV3 | StoredAgentV4): entry is StoredAgentV4 {
  return 'taskState' in entry;
}

// Day 15 added planApproved/validationPassed to TaskState — a store written
// before that exists without them. Rather than another whole StoredAgent
// version for two booleans, tolerate their absence here and default to the
// safe value (nothing pre-approved).
function normalizeTaskState(taskState: TaskState | null): TaskState | null {
  if (!taskState) return null;
  return {
    ...taskState,
    planApproved: taskState.planApproved ?? false,
    validationPassed: taskState.validationPassed ?? false,
  };
}

/**
 * Keeps one Agent per chat id alive in memory and mirrors its conversation
 * state to disk, so a chat's context survives a backend restart: on boot we
 * read the store back in, and after every turn we write it out again.
 */
@Injectable()
export class AgentsService implements OnModuleInit {
  private readonly logger = new Logger(AgentsService.name);
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly memoryService: MemoryService,
    private readonly profileService: ProfileService,
    private readonly invariantService: InvariantService,
    private readonly mcpService: McpService,
  ) {}

  async onModuleInit() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      const stored: Record<string, StoredAgent> = JSON.parse(raw);
      for (const [id, entry] of Object.entries(stored)) {
        if (isV2(entry)) {
          const workingMemory = isV3(entry) ? entry.workingMemory : {};
          const taskState = normalizeTaskState(isV3(entry) && isV4(entry) ? entry.taskState : null);
          this.agents.set(
            id,
            new Agent(
              id,
              entry.branches,
              entry.activeBranchId,
              entry.summary,
              entry.summarizedThroughIndex,
              entry.facts,
              workingMemory,
              taskState,
            ),
          );
          continue;
        }
        // Older stores kept a bare message array, or {history, summary, summarizedThroughIndex} with no branches/facts.
        const { history, summary, summarizedThroughIndex } = Array.isArray(entry)
          ? { history: entry, summary: '', summarizedThroughIndex: 0 }
          : entry;
        this.agents.set(id, new Agent(id, { main: history }, 'main', summary, summarizedThroughIndex, {}, {}, null));
      }
      this.logger.log(`Restored ${this.agents.size} agent(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read agent store: ${(error as Error).message}`);
      }
    }
  }

  private getOrCreate(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = new Agent(id);
      this.agents.set(id, agent);
    }
    return agent;
  }

  async ask(
    id: string,
    prompt: string,
    reasoningMode?: ReasoningMode,
    options?: AskOptions,
    contextConfig?: ContextConfig,
    memoryConfig?: MemoryConfig,
    profileId?: string,
    taskConfig?: TaskConfig,
    invariantConfig?: InvariantConfig,
    mcpConfig?: McpConfig,
  ): Promise<AgentAskResult> {
    const agent = this.getOrCreate(id);
    const tools = (mcpConfig?.useTools ?? true) ? this.buildMcpToolset() : undefined;
    const longTermMemoryText = this.memoryService.formatForPrompt();
    const profileText = this.profileService.formatForPrompt(profileId);
    const activeInvariants = this.invariantService.listActive();
    const result = await agent.ask(
      prompt,
      reasoningMode,
      { ...options, profile: profileText, tools },
      contextConfig,
      memoryConfig,
      longTermMemoryText,
      taskConfig,
      activeInvariants,
      invariantConfig,
    );
    // Agent only ever sees the already-formatted profile text, not its id/name
    // (that'd mean handing it a ProfileService dependency just to label its
    // own output) — attach the label here, where both are in scope.
    if (profileId) {
      const profile = this.profileService.get(profileId);
      if (profile) result.profile = { id: profile.id, name: profile.name };
    }
    // Long-term memory is global, not part of the Agent — apply whatever the
    // routing step proposed to the shared store here, after the turn's own
    // state (history, working memory) has already been decided.
    if (result.memory?.longTermAdded.length) {
      await this.memoryService.upsertMany(result.memory.longTermAdded, 'agent');
    }
    await this.persist();
    return result;
  }

  /**
   * Exposes every tool of every connected MCP server to the model (Day 17).
   * OpenAI function names allow only [a-zA-Z0-9_-]{1,64} and must be unique
   * across servers, so names are sanitized and a clash is prefixed with the
   * server's name; the map resolves each back to its server + real tool name.
   */
  private buildMcpToolset(): LlmToolset | undefined {
    const connected = this.mcpService.listConnectedTools();
    if (connected.length === 0) return undefined;

    const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
    const routes = new Map<string, { serverId: string; serverName: string; toolName: string }>();
    const tools: LlmTool[] = [];
    for (const { serverId, serverName, tool } of connected) {
      let name = sanitize(tool.name).slice(0, 64);
      if (routes.has(name)) name = `${sanitize(serverName)}__${sanitize(tool.name)}`.slice(0, 64);
      for (let n = 2; routes.has(name); n++) name = `${sanitize(tool.name).slice(0, 60)}_${n}`;
      routes.set(name, { serverId, serverName, toolName: tool.name });
      tools.push({ name, description: tool.description ?? tool.title, parameters: tool.inputSchema });
    }

    return {
      tools,
      execute: async (name, args) => {
        const route = routes.get(name);
        if (!route) return { content: `Unknown tool: ${name}`, isError: true };
        const result = await this.mcpService.callTool(route.serverId, route.toolName, args);
        return { ...result, source: { server: route.serverName, tool: route.toolName } };
      },
    };
  }

  getHistory(id: string): ChatMessage[] {
    return this.agents.get(id)?.history ?? [];
  }

  getWorkingMemory(id: string): Record<string, string> {
    return this.agents.get(id)?.workingMemory ?? {};
  }

  async clearWorkingMemory(id: string): Promise<void> {
    this.getOrCreate(id).clearWorkingMemory();
    await this.persist();
  }

  getTaskState(id: string): TaskState | null {
    return this.agents.get(id)?.taskState ?? null;
  }

  async pauseTask(id: string): Promise<void> {
    this.getOrCreate(id).pauseTask();
    await this.persist();
  }

  async resumeTask(id: string): Promise<void> {
    this.getOrCreate(id).resumeTask();
    await this.persist();
  }

  async setTaskStage(id: string, stage: TaskStage): Promise<void> {
    this.getOrCreate(id).setTaskStage(stage);
    await this.persist();
  }

  async resetTask(id: string): Promise<void> {
    this.getOrCreate(id).resetTask();
    await this.persist();
  }

  async approvePlan(id: string): Promise<void> {
    this.getOrCreate(id).approvePlan();
    await this.persist();
  }

  async approveValidation(id: string): Promise<void> {
    this.getOrCreate(id).approveValidation();
    await this.persist();
  }

  listBranches(id: string): { branches: { id: string; messageCount: number }[]; activeBranchId: string } {
    const agent = this.agents.get(id);
    return {
      branches: agent?.listBranches() ?? [{ id: 'main', messageCount: 0 }],
      activeBranchId: agent?.activeBranchId ?? 'main',
    };
  }

  async createBranch(id: string, name: string, fromBranchId?: string): Promise<void> {
    this.getOrCreate(id).createBranch(name, fromBranchId);
    await this.persist();
  }

  async switchBranch(id: string, branchId: string): Promise<void> {
    this.getOrCreate(id).switchBranch(branchId);
    await this.persist();
  }

  async deleteBranch(id: string, branchId: string): Promise<void> {
    this.getOrCreate(id).deleteBranch(branchId);
    await this.persist();
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
    const snapshot: Record<string, StoredAgentV4> = {};
    for (const [id, agent] of this.agents) {
      snapshot[id] = {
        branches: agent.branches,
        activeBranchId: agent.activeBranchId,
        summary: agent.summary,
        summarizedThroughIndex: agent.summarizedThroughIndex,
        facts: agent.facts,
        workingMemory: agent.workingMemory,
        taskState: agent.taskState,
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
