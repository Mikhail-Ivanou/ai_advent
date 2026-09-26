import 'dotenv/config';
import { timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as path from 'path';
import { FILES_DIR, Pipeline, signFilename } from './pipeline.js';
import { Scheduler } from './scheduler.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createResearchServer, createSchedulerServer, createWeatherServer } from './server.js';

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

// One scheduler for the whole process: MCP servers are created per request,
// but the tasks and their timer must outlive any single request.
const scheduler = new Scheduler();
await scheduler.start();
const pipeline = new Pipeline();
await pipeline.load();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// One endpoint per MCP server (Day 20) — the app registers each separately.
const SERVERS: Record<string, () => McpServer> = {
  weather: () => createWeatherServer(),
  scheduler: () => createSchedulerServer(scheduler),
  research: () => createResearchServer(pipeline),
};

// Stateless Streamable HTTP: every POST gets a fresh server + transport, so
// there's no session state to lose on restart and it scales horizontally.
app.post('/mcp/:server', requireToken, async (req, res) => {
  const factory = SERVERS[String(req.params.server)];
  if (!factory) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Unknown MCP server; available: ${Object.keys(SERVERS).join(', ')}` },
      id: null,
    });
    return;
  }
  const server = factory();
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

// Files written by save_to_file: the bearer token, or the per-file signature
// from the link save_to_file returned (see signFilename). The name is reduced
// to its basename so nothing outside FILES_DIR can be requested.
function requireFileAccess(req: Request, res: Response, next: NextFunction) {
  const name = path.basename(String(req.params.name));
  const sig = typeof req.query.sig === 'string' ? Buffer.from(req.query.sig) : undefined;
  const expected = AUTH_TOKEN ? Buffer.from(signFilename(name, AUTH_TOKEN)) : undefined;
  if (sig && expected && sig.length === expected.length && timingSafeEqual(sig, expected)) return next();
  return requireToken(req, res, next);
}

app.get('/files/:name', requireFileAccess, (req, res) => {
  const name = path.basename(String(req.params.name));
  res.sendFile(name, { root: FILES_DIR, dotfiles: 'deny' }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
});

// No sessions means no server-initiated stream (GET) and nothing to end (DELETE).
app.all('/mcp/:server', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

app.listen(PORT, HOST, () => {
  const endpoints = Object.keys(SERVERS).map((name) => `/mcp/${name}`).join(', ');
  console.log(`MCP servers listening on http://${HOST}:${PORT}: ${endpoints}${AUTH_TOKEN ? ' (bearer auth on)' : ''}`);
});
