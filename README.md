# Advent

Side-project scaffold for this year's advent challenge. Monorepo with a NestJS
backend and a Next.js frontend, wired together for local development.

## Structure

```
advent/
├── backend/      NestJS API (TypeScript)
├── web/          Next.js frontend (TypeScript, App Router, Tailwind)
└── mcp-weather/  MCP server with a weather tool (see mcp-weather/README.md)
```

## Getting started

Install everything from the root (npm workspaces links the two packages):

```bash
npm install
```

Run both apps in separate terminals:

```bash
npm run dev:backend   # http://localhost:3001
npm run dev:web        # http://localhost:3000
npm run dev:mcp-weather  # http://localhost:3002/mcp — optional, weather MCP tool
```

The web app proxies `/api/backend/*` to the backend (see `web/next.config.mjs`),
so frontend code can call `/api/backend/health` instead of hardcoding a host.

## Environment variables

Each package has a `.env.example`. Copy to `.env` and adjust as needed:

```bash
cp backend/.env.example backend/.env
cp web/.env.example web/.env.local
cp mcp-weather/.env.example mcp-weather/.env
```

## Adding a day's challenge

This is intentionally bare-bones — a starting point for whatever the challenge
turns out to be. Add modules/routes to `backend/src` and pages/components to
`web/src/app` as the actual challenge repos come in.

## Next steps

- [ ] Drop in the actual challenge repo(s) mentioned separately
- [ ] Decide on a datastore (Postgres/SQLite/etc.) and wire it into `backend`
- [ ] Add CI (lint + build) once the shape of the project settles
