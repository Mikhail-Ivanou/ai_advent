import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Agent, AgentAskResult } from './agent';
import { AskOptions, ChatMessage, ReasoningMode } from './llm.client';

const STORE_PATH = path.join(process.cwd(), 'data', 'agents.json');

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
      const stored: Record<string, ChatMessage[]> = JSON.parse(raw);
      for (const [id, history] of Object.entries(stored)) {
        this.agents.set(id, new Agent(id, history));
      }
      this.logger.log(`Restored ${this.agents.size} agent(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read agent store: ${(error as Error).message}`);
      }
    }
  }

  async ask(id: string, prompt: string, reasoningMode?: ReasoningMode, options?: AskOptions): Promise<AgentAskResult> {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = new Agent(id);
      this.agents.set(id, agent);
    }

    const result = await agent.ask(prompt, reasoningMode, options);
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

  private async persist(): Promise<void> {
    const snapshot: Record<string, ChatMessage[]> = {};
    for (const [id, agent] of this.agents) snapshot[id] = agent.history;

    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
  }
}
