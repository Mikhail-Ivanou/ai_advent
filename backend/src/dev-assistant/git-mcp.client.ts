import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LlmTool, LlmToolset } from '../llm/llm.client';

// Day 31: the assistant's connection to the project itself — the "git" MCP
// server (mcp-weather/src/git.ts). It's a fixed part of the assistant, not
// one of the user-managed servers of the agent chat, so it has its own small
// client: one lazy connection, re-established once when a call fails.

const MCP_URL = process.env.DEV_ASSISTANT_MCP_URL?.trim() || 'http://localhost:3002/mcp/git';
const MCP_TOKEN = process.env.DEV_ASSISTANT_MCP_TOKEN?.trim() || process.env.MCP_AUTH_TOKEN?.trim() || undefined;
const CALL_TIMEOUT_MS = 30_000;

export interface BranchInfo {
  branch: string;
  detached: boolean;
  head: { sha: string; subject: string; date: string };
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface GitToolResult {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
}

export class GitMcpClient {
  readonly url = MCP_URL;
  private client?: Promise<Client>;
  private tools?: { name: string; description?: string; inputSchema: Record<string, unknown> }[];

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: 'advent-dev-assistant', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: MCP_TOKEN ? { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } : undefined,
      });
      await client.connect(transport);
      this.tools = (await client.listTools()).tools as typeof this.tools;
      return client;
    })().catch((error) => {
      this.client = undefined;
      throw new Error(`MCP-сервер git недоступен (${MCP_URL}): ${(error as Error).message}`);
    });
    return this.client;
  }

  async listTools() {
    await this.connect();
    return this.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<GitToolResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
        const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
        return {
          text: content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'),
          isError: Boolean(result.isError),
          structured: result.structuredContent as Record<string, unknown> | undefined,
        };
      } catch (error) {
        // A restarted server forgets nothing (it's stateless), but our
        // transport may be stale — reconnect once before giving up.
        this.client = undefined;
        if (attempt > 0) throw error;
      }
    }
  }

  async currentBranch(): Promise<BranchInfo> {
    const result = await this.call('git_current_branch');
    if (result.isError || !result.structured) throw new Error(result.text || 'git_current_branch вернул пустой ответ');
    return result.structured as unknown as BranchInfo;
  }

  /** The git tools as functions for the model, every call routed back to the server and recorded. */
  async toolset(): Promise<LlmToolset> {
    const tools: LlmTool[] = (await this.listTools()).map((t) => ({
      name: t.name,
      description: `[MCP-сервер «git»] ${t.description ?? ''}`.trim(),
      parameters: t.inputSchema,
    }));
    return {
      tools,
      execute: async (name, args) => {
        const result = await this.call(name, args);
        return { content: result.text, isError: result.isError, source: { server: 'git', tool: name } };
      },
    };
  }
}
