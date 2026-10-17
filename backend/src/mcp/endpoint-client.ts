import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LlmTool, LlmToolset } from '../llm/llm.client';

// A fixed MCP server an assistant always uses (Day 31: git, Day 33: CRM) —
// unlike the user-managed servers of the agent chat (McpService). One lazy
// connection, re-established once when a call fails.

const CALL_TIMEOUT_MS = 30_000;
/**
 * The SDK's HTTP transport sends every request with its one AbortSignal, and
 * each fetch leaves a listener on it — after 100 calls Node warns, and they
 * keep piling up for as long as the connection lives. The servers are
 * stateless, so a fresh connection every so often costs one handshake.
 */
const CALLS_PER_CONNECTION = 50;

export interface McpToolResult {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export class McpEndpointClient {
  private client?: Promise<Client>;
  private tools?: ToolInfo[];
  private calls = 0;

  /** `label` names the server in errors and in tool descriptions shown to the model. */
  constructor(
    readonly url: string,
    readonly label: string,
    private readonly token?: string,
  ) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: `advent-${this.label}-client`, version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined,
      });
      await client.connect(transport);
      this.tools = (await client.listTools()).tools as ToolInfo[];
      return client;
    })().catch((error) => {
      this.client = undefined;
      throw new Error(`MCP-сервер ${this.label} недоступен (${this.url}): ${(error as Error).message}`);
    });
    return this.client;
  }

  async listTools(): Promise<ToolInfo[]> {
    await this.connect();
    return this.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (++this.calls > CALLS_PER_CONNECTION) await this.recycle();
        const client = await this.connect();
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
        const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
        return {
          text: content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'),
          isError: Boolean(result.isError),
          structured: result.structuredContent as Record<string, unknown> | undefined,
        };
      } catch (error) {
        // The servers are stateless, but our transport may be stale after a
        // restart — reconnect once before giving up.
        this.client = undefined;
        if (attempt > 0) throw error;
      }
    }
  }

  private async recycle(): Promise<void> {
    const old = this.client;
    this.client = undefined;
    this.calls = 1;
    await old?.then((c) => c.close()).catch(() => undefined);
  }

  /** The server's tools as functions for the model, every call routed back here. `only` restricts which. */
  async toolset(only?: (tool: ToolInfo) => boolean): Promise<LlmToolset> {
    const tools: LlmTool[] = (await this.listTools())
      .filter((t) => !only || only(t))
      .map((t) => ({
        name: t.name,
        description: `[MCP-сервер «${this.label}»] ${t.description ?? ''}`.trim(),
        parameters: t.inputSchema,
      }));
    const allowed = new Set(tools.map((t) => t.name));
    return {
      tools,
      execute: async (name, args) => {
        if (!allowed.has(name)) return { content: `Инструмент ${name} недоступен`, isError: true };
        const result = await this.call(name, args);
        return { content: result.text, isError: result.isError, source: { server: this.label, tool: name } };
      },
    };
  }
}
