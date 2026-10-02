# Advent

Side-project scaffold for this year's advent challenge. Monorepo with a NestJS
backend and a Next.js frontend, wired together for local development.

## Structure

```
advent/
├── backend/      NestJS API (TypeScript)
├── web/          Next.js frontend (TypeScript, App Router, Tailwind)
└── mcp-weather/  MCP server with a weather tool (see mcp-weather/README.md)
docs/             reports (e.g. Day 21 chunking comparison)
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

## Day 21 — document indexing (RAG)

`backend/src/rag` builds a local index of documents for retrieval:

- **Sources**: a URL (HTML article, raw README, PDF, fb2) or an uploaded file —
  `.fb2` (incl. windows-1251), `.pdf`, `.md`, `.html`, `.txt`, source code.
  Each is parsed into a section tree (book sections, headings, PDF pages,
  top-level code declarations).
- **Chunking**, both strategies for every document:
  - `fixed` — a sliding window of `size` characters with `overlap`, snapped to
    sentence/word boundaries, ignoring structure;
  - `structural` — one chunk per section; long sections split by paragraphs
    (≤ `maxSize`), short ones merged with siblings/parent text (< `minSize`);
    each chunk starts with its heading path.
- **Embeddings** locally with transformers.js (`Xenova/multilingual-e5-small`,
  384 dims, no API key; the model is downloaded once into `data/rag/models`).
- **Index**: `backend/data/rag/fixed.json` and `structural.json` — chunk text,
  embedding and metadata (`chunk_id`, `source`, `title`, `file`, `section`,
  offsets, `sectionsSpanned`, `part`); parsed documents in `data/rag/documents`.

UI: http://localhost:3000/rag — add documents, view chunks of both strategies
side by side, search, compare. CLI:

```bash
npm run rag --workspace=backend -- index book.fb2 https://ru.wikipedia.org/wiki/Нейронная_сеть
npm run rag --workspace=backend -- search "как обучается перцептрон"
npm run rag --workspace=backend -- compare --sample 80 --report ../docs/day21-chunking.md
npm run rag --workspace=backend -- params --size 800 --overlap 100 --max 1400 --min 300
```

In the chat, the **RAG — документы** panel turns retrieval on per chat
(off by default) and picks the index (`structural`/`fixed`) and top-k. The
question becomes the search query; the chunks go into the prompt numbered
`[n]` with their file and section, and the sources used are listed under the
answer. The header button **RAG: документы →** opens `/rag`.
`RAG_DATA_DIR` moves the index elsewhere (e.g. a scratch index for experiments).

The comparison reports chunk-size statistics, truncation by the model's token
limit, chunks spanning several sections, mid-sentence cuts, and two
label-free retrieval checks (a document sentence → its place; a section
heading → its section). See [docs/day21-chunking.md](docs/day21-chunking.md).

## Day 22 — first RAG request

`backend/src/rag/rag-answer.ts`: question → relevant chunks → chunks joined
with the question → LLM, in two modes (`plain` / `rag`). Search is `hybrid`
by default (embeddings + BM25 fused by reciprocal rank; rare names are found
literally) or `vector`. The chat, `POST /rag/ask` (both answers side by side,
also on the `/rag` page) and the evaluation use it.

Control questions: `backend/src/rag/eval/ufo-questions.json` — 10 questions
over the indexed book with the expected answer, key facts and source chapter
+ verbatim quote. Each is answered without and with RAG and scored
(retrieval rank of the source passage, key facts, LLM judge, citations):

```bash
npm run rag-eval --workspace=backend -- --strategy structural --search hybrid --k 5 --report ../docs/day22-rag-eval.md
```

Result: [docs/day22-rag-eval.md](docs/day22-rag-eval.md).

## Next steps

- [ ] Drop in the actual challenge repo(s) mentioned separately
- [ ] Decide on a datastore (Postgres/SQLite/etc.) and wire it into `backend`
- [ ] Add CI (lint + build) once the shape of the project settles
