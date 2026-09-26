/** Wire protocol: 'auto' tries Streamable HTTP first and falls back to legacy SSE. */
export type McpTransport = 'auto' | 'http' | 'sse';

/** A remote MCP server as the user configured it — what gets persisted. */
export interface McpServer {
  id: string;
  /** Short label to tell servers apart in the list. */
  name: string;
  url: string;
  transport: McpTransport;
  /** Extra request headers, typically `Authorization: Bearer …`. */
  headers: Record<string, string>;
  /** Whether the server should be connected — restored in the background on start-up. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type McpServerInput = Pick<McpServer, 'name' | 'url' | 'transport' | 'headers'>;

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Live connection state for one server — kept in memory only. */
export interface McpConnectionState {
  status: McpConnectionStatus;
  /** Protocol actually in use — for 'auto' this is whichever one the server answered on. */
  activeTransport?: 'http' | 'sse';
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  tools: McpTool[];
  error?: string;
  connectedAt?: string;
}

export type McpServerView = McpServer & McpConnectionState;

/** `_meta` key our MCP servers read to scope state per chat — see mcp-weather's scheduler. */
export const CHAT_ID_META_KEY = 'advent/chatId';

export function chatMeta(chatId: string): Record<string, unknown> {
  return { [CHAT_ID_META_KEY]: chatId };
}
