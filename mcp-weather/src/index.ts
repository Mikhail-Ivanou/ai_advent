import 'dotenv/config';
import { timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWeatherServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3002);
const HOST = process.env.HOST ?? '0.0.0.0';
// Optional locally, but set it on any public deployment — otherwise anyone
// who finds the URL can use the server.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || undefined;

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(AUTH_TOKEN);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  res.status(401).set('WWW-Authenticate', 'Bearer').json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Stateless Streamable HTTP: every POST gets a fresh server + transport, so
// there's no session state to lose on restart and it scales horizontally.
app.post('/mcp', requireToken, async (req, res) => {
  const server = createWeatherServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// No sessions means no server-initiated stream (GET) and nothing to end (DELETE).
app.all('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Weather MCP server listening on http://${HOST}:${PORT}/mcp${AUTH_TOKEN ? ' (bearer auth on)' : ''}`);
});
