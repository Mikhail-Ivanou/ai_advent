import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { McpConnectionState, McpServer, McpServerInput, McpServerView, McpTool } from './mcp.types';

const STORE_PATH = path.join(process.cwd(), 'data', 'mcp-servers.json');

type ActiveTransport = NonNullable<McpConnectionState['activeTransport']>;

// Transport errors often carry the HTTP status only in `code` (e.g. a 401 with
// an empty body reads as "Error POSTing to endpoint: "), so surface it.
function describeError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  const message = error.message.trim();
  return typeof code === 'number' && code >= 100 && !message.includes(String(code)) ? `${message} (HTTP ${code})` : message;
}

/**
 * MCP client (Day 16): any number of remote MCP servers reached by URL, each
 * with its own connection. Server configs are persisted; connections live in
 * memory and the ones that were up are re-established in the background on
 * start-up, so an unreachable server never blocks the backend from booting.
 */
@Injectable()
export class McpService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private servers: McpServer[] = [];
  private readonly clients = new Map<string, Client>();
  private readonly states = new Map<string, McpConnectionState>();
  /** Bumped by every connect/disconnect/remove, so a slow handshake can tell it's been superseded. */
  private readonly generations = new Map<string, number>();

  async onApplicationBootstrap() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      this.servers = JSON.parse(raw);
      this.logger.log(`Restored ${this.servers.length} MCP server(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read MCP server store: ${(error as Error).message}`);
      }
    }
    for (const server of this.servers) {
      if (server.enabled) void this.connect(server.id);
    }
  }

  async onModuleDestroy() {
    await Promise.all([...this.clients.keys()].map((id) => this.closeClient(id)));
  }

  list(): McpServerView[] {
    return [...this.servers].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => this.view(s));
  }

  async create(input: McpServerInput): Promise<McpServerView> {
    const now = new Date().toISOString();
    const server: McpServer = {
      id: randomUUID(),
      ...this.normalizeInput(input),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.servers.push(server);
    await this.persist();
    return this.connect(server.id);
  }

  async update(id: string, patch: Partial<McpServerInput>): Promise<McpServerView> {
    const server = this.find(id);
    Object.assign(server, this.normalizeInput({ ...server, ...patch }));
    server.updatedAt = new Date().toISOString();
    await this.persist();
    // New URL/headers only take effect on a fresh handshake.
    return server.enabled ? this.connect(id) : this.view(server);
  }

  async remove(id: string): Promise<void> {
    this.find(id);
    this.nextGeneration(id);
    await this.closeClient(id);
    this.states.delete(id);
    this.generations.delete(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    await this.persist();
  }

  async connect(id: string): Promise<McpServerView> {
    const server = this.find(id);
    const generation = this.nextGeneration(id);
    await this.closeClient(id);
    this.states.set(id, { status: 'connecting', tools: [] });
    if (!server.enabled) {
      server.enabled = true;
      await this.persist();
    }

    const attempts: ActiveTransport[] = server.transport === 'auto' ? ['http', 'sse'] : [server.transport];
    const failures: string[] = [];

    for (const kind of attempts) {
      const client = await this.tryConnect(server, kind).catch((error: Error) => {
        const message = describeError(error);
        failures.push(attempts.length > 1 ? `${kind.toUpperCase()}: ${message}` : message);
        return null;
      });
      if (!client) continue;

      // The server may have been deleted, disconnected or reconnected while we were waiting.
      if (this.generations.get(id) !== generation) {
        await client.close().catch(() => {});
        return this.view(server);
      }

      this.clients.set(id, client);
      const info = client.getServerVersion();
      const state: McpConnectionState = {
        status: 'connected',
        activeTransport: kind,
        serverInfo: info ? { name: info.name, version: info.version } : undefined,
        protocolVersion: (client.transport as { protocolVersion?: string } | undefined)?.protocolVersion,
        tools: [],
        connectedAt: new Date().toISOString(),
      };
      this.states.set(id, state);
      try {
        state.tools = await this.fetchTools(client);
        this.logger.log(`Connected to MCP server "${server.name}" via ${kind}: ${state.tools.length} tool(s)`);
      } catch (error) {
        state.error = `Не удалось получить список инструментов: ${(error as Error).message}`;
      }
      return this.view(server);
    }

    if (this.generations.get(id) === generation) {
      this.states.set(id, { status: 'error', tools: [], error: failures.join('\n') });
    }
    this.logger.warn(`MCP server "${server.name}" connection failed: ${failures.join('; ')}`);
    return this.view(server);
  }

  async disconnect(id: string): Promise<McpServerView> {
    const server = this.find(id);
    this.nextGeneration(id);
    await this.closeClient(id);
    this.states.set(id, { status: 'disconnected', tools: [] });
    server.enabled = false;
    await this.persist();
    return this.view(server);
  }

  async refreshTools(id: string): Promise<McpServerView> {
    const server = this.find(id);
    const client = this.clients.get(id);
    const state = this.states.get(id);
    if (!client || !state) throw new BadRequestException(`MCP-сервер «${server.name}» не подключён`);
    try {
      state.tools = await this.fetchTools(client);
      state.error = undefined;
    } catch (error) {
      state.error = (error as Error).message;
    }
    return this.view(server);
  }

  /** Runs the MCP handshake over one transport; resolves to a live client or rejects with the transport's error. */
  private async tryConnect(server: McpServer, kind: ActiveTransport): Promise<Client> {
    const client = new Client({ name: 'advent-backend', version: '0.0.1' });
    client.onclose = () => {
      // Fires both on our own disconnect and when the server goes away;
      // only the latter should be reported as a lost connection.
      if (this.clients.get(server.id) !== client) return;
      this.clients.delete(server.id);
      this.states.set(server.id, { status: 'error', tools: [], error: 'Соединение закрыто сервером' });
    };
    const url = new URL(server.url);
    const requestInit: RequestInit = { headers: server.headers };
    const transport =
      kind === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private async fetchTools(client: Client): Promise<McpTool[]> {
    // tools/list is paginated; follow the cursor so large servers aren't truncated.
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private normalizeInput(input: Partial<McpServerInput>): McpServerInput {
    const url = (input.url ?? '').trim();
    try {
      const { protocol } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error();
    } catch {
      throw new BadRequestException(`Некорректный URL: ${url || '(пусто)'}`);
    }
    const transport = input.transport ?? 'auto';
    if (!['auto', 'http', 'sse'].includes(transport)) {
      throw new BadRequestException(`Неизвестный протокол: ${transport}`);
    }
    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {})
        .map(([k, v]) => [k.trim(), String(v).trim()])
        .filter(([k]) => k),
    );
    return { name: input.name?.trim() || new URL(url).host, url, transport, headers };
  }

  private nextGeneration(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  private find(id: string): McpServer {
    const server = this.servers.find((s) => s.id === id);
    if (!server) throw new NotFoundException(`Unknown MCP server: ${id}`);
    return server;
  }

  private view(server: McpServer): McpServerView {
    const state = this.states.get(server.id) ?? { status: server.enabled ? 'connecting' : 'disconnected', tools: [] };
    return { ...server, ...state };
  }

  private async closeClient(id: string) {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) await client.close().catch(() => {});
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const snapshot = [...this.servers];
    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    };
    const current = this.writeQueue.then(writeSnapshot, writeSnapshot);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
