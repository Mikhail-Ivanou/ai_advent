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
npm run rag-eval --workspace=backend -- --modes baseline --report ../docs/day22-rag-eval.md
```

Result: [docs/day22-rag-eval.md](docs/day22-rag-eval.md).

## Day 23 — reranking, filtering, query rewrite

Retrieval is a pipeline (`backend/src/rag/rag-pipeline.ts`):

```
question → [query rewrite] → candidates (top-K before) → [rerank] → [threshold] → top-K after → LLM
```

- **Query rewrite**: the LLM turns the question into a search query (filler
  dropped, names kept, words likely near the answer added); the original and
  the rewrite are both searched and the rankings fused (RRF).
- **Rerankers** (`reranker.ts`): `cross-encoder` — local multilingual
  `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (ONNX int8, ~120 MB, downloaded
  once into `data/rag/models`), reads question + chunk together, 0..1;
  `llm` — the chat model rates all candidates 0–10 in one call.
- **Threshold** on the reranker's score (or cosine without one); thresholds
  calibrated on the book: cross-encoder 0.2, LLM 0.6. When nothing passes,
  the model is told the documents have no answer instead of answering from
  memory.

Settings are in the chat's RAG panel and on `/rag` (both answers side by side,
candidates before / after filtering). Comparison of modes over the control
questions (10 with an answer in the book + 3 without):

```bash
npm run rag-eval --workspace=backend -- --report ../docs/day23-rag-modes.md
```

Result: [docs/day23-rag-modes.md](docs/day23-rag-modes.md).

## Day 24 — sources, quotes, "не знаю"

With RAG the model must reply as `ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ` (verbatim
fragments of the excerpts it got) or `НЕ ЗНАЮ: <what to clarify>`.
`backend/src/rag/grounding.ts` checks the reply against the excerpts:

- sources are resolved from `[n]` to the real chunks (source, section,
  chunk_id) — an excerpt only listed, with nothing quoted or cited from it,
  is dropped;
- each quote is looked up in its excerpt: exact, approximate (≥ 85% of its
  words in order) or not found; a quote attributed to the wrong excerpt is
  re-attributed;
- **no confirmed quote → no answer**: "Не знаю" with a request to clarify
  (the rejected answer is kept for inspection);
- **weak context** (nothing above the relevance threshold) → "Не знаю",
  the best relevance vs the threshold, the nearest sections, and a request
  to clarify — without calling the LLM.

The chat and `/rag` show sources, quotes with ✓ / ≈ / ✗ and the reason for
"не знаю". The evaluation adds: answers with sources, with quotes, confirmed
quotes, and whether an LLM shown only the answer and the quotes finds the
answer supported by them:

```bash
npm run rag-eval --workspace=backend -- --modes baseline,ce,llm --report ../docs/day24-grounded.md
```

## Day 25 — mini chat with RAG and task memory

http://localhost:3000/rag-chat (backend: `src/rag-chat`, `POST /rag-chat/:id/messages`).
Dialogs are kept in `backend/data/rag-chats.json`. Every message:

1. **Task memory + standalone query** — one LLM call updates the dialog's
   task memory (goal; what the user clarified; constraints; terms) and turns
   a follow-up ("а кто ещё погиб там?") into a self-contained search query;
   it also tells what kind of message it is:
   - `search` — a question about the documents;
   - `note` — only a clarification / constraint / term: recorded in memory,
     confirmed, nothing searched;
   - `dialog` — about the dialog itself ("подведи итог", "напомни цель"):
     answered from memory and history, citing the sources gathered so far.
2. **Retrieval** with that query (hybrid → cross-encoder → threshold 0.2).
3. **Answer** with the memory and recent history in the prompt, in the Day 24
   format — sources and verified quotes; weak context → "не знаю".

The memory panel shows the goal / clarified / constraints / terms after each
message and can be edited. Two long scripted dialogs (13 and 12 messages)
check that sources keep coming and the goal is not lost:

```bash
npm run rag-chat-check --workspace=backend -- --report ../docs/day25-rag-chat.md
```

## Next steps

- [ ] Drop in the actual challenge repo(s) mentioned separately
- [ ] Decide on a datastore (Postgres/SQLite/etc.) and wire it into `backend`
- [ ] Add CI (lint + build) once the shape of the project settles
