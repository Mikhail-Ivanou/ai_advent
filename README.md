# Advent

Side-project scaffold for this year's advent challenge. Monorepo with a NestJS
backend and a Next.js frontend, wired together for local development.

## Structure

```
advent/
├── backend/      NestJS API (TypeScript)
├── web/          Next.js frontend (TypeScript, App Router, Tailwind)
├── mcp-weather/  MCP server with a weather tool (see mcp-weather/README.md)
└── llm-gateway/  network gateway to the local Ollama model (see llm-gateway/README.md)
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
npm run dev:mcp-weather  # http://localhost:3002/mcp/{weather,scheduler,research,git} — MCP servers
npm run dev:llm-gateway  # http://0.0.0.0:8088/v1 — local LLM as a private network service
```

The web app proxies `/api/backend/*` to the backend (see `web/next.config.mjs`),
so frontend code can call `/api/backend/health` instead of hardcoding a host.

## Environment variables

Each package has a `.env.example`. Copy to `.env` and adjust as needed:

```bash
cp backend/.env.example backend/.env
cp web/.env.example web/.env.local
cp mcp-weather/.env.example mcp-weather/.env
cp llm-gateway/.env.example llm-gateway/.env   # then set GATEWAY_KEYS
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

## Day 26 — local LLM (Ollama)

A local model runs through [Ollama](https://ollama.com) and plugs into the same
`callLlm` as the cloud ones: a model named `ollama/<name>` is sent to
`LOCAL_LLM_API_URL` (default `http://localhost:11434/v1`, Ollama's
OpenAI-compatible API) with the prefix stripped, no API key, cost 0.

```bash
brew install ollama && brew services start ollama
ollama pull qwen2.5:7b
ollama run qwen2.5:7b "Привет"                                      # Ollama CLI
curl localhost:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"2+2?","stream":false}'
npm run ask --workspace=backend -- --model ollama/qwen2.5:7b "Столица Франции?"
```

In the chat UI pick **Локальная (Ollama, qwen2.5:7b)** or **(…, gemma3:12b)** in the Model selector
(`ollama pull gemma3:12b` first). gemma3 has no tool calling — with MCP on, the
request is retried without tools.
Test run: [docs/day26-local-llm.md](docs/day26-local-llm.md).

## Day 28 — local LLM + RAG

The RAG pipeline runs fully on this machine: the Week 6 index
(`backend/data/rag`, e5 embeddings via transformers.js), hybrid search
(vectors + BM25), the local cross-encoder reranker and threshold, and the
answer from a local model through Ollama (Day 26) in the Day 24 grounded
format. Pick the model:

- `/rag` — "модель" next to the reranker settings;
- `/rag-chat` — "модель" in the chat's search settings (memory, answer and
  LLM reranker all use it);
- `/chat` with RAG on — the usual Model selector.

Local vs cloud on the control questions — quality (same judge, facts,
quotes, "не знаю" as Days 22–24), speed (model load, answer time,
retrieval vs LLM) and stability (each question asked several times at
temperature 0: same verdict / same answer, format kept, language kept,
errors):

```bash
brew services start ollama
npm run rag-local --workspace=backend -- --runs 3 --report ../docs/day28-local-rag.md
# --models ollama/gemma3:12b,ollama/qwen2.5:7b,deepseek-v4-flash  --judge deepseek-v4-pro  --only q1,n1
```

Result: [docs/day28-local-rag.md](docs/day28-local-rag.md).

## Day 29 — optimizing a local LLM for one task

A task of its own, without RAG or tools: a customer's e-mail to an appliance
shop → the order as JSON (customer, phone, city, catalog SKUs with final
quantities, delivery date, payment, urgency). `qwen2.5:7b` in Ollama on
three quantizations (Q3_K_M, Q4_K_M, Q8_0); the prompt
(`backend/src/order-extract/prompt.ts`) is the same everywhere — only
temperature, max tokens (`num_predict`) and the context window (`num_ctx`)
change. 12 control e-mails with expected orders
(`backend/src/order-extract/dataset.ts`), 3 of them ≈5k tokens long; scored
field by field automatically. Quality, speed (cold load, prompt reading vs
generation from Ollama's own timings), memory and stability per config:

```bash
cd backend
ollama pull qwen2.5:7b && ollama pull qwen2.5:7b-instruct-q3_K_M && ollama pull qwen2.5:7b-instruct-q8_0
# the optimized model — Modelfile generated from the prompt and the chosen parameters
npm run order-extract -- --modelfile ollama/order-extractor.Modelfile
ollama create order-extractor -f ollama/order-extractor.Modelfile
npm run order-extract -- --runs 3 --save data/order-extract-results.json --report ../docs/day29-local-optimization.md
# --configs q4-default,q4-opt,extractor  --only e1,L1  --tokens (prompt length per e-mail)
```

`order-extractor` = Q4_K_M, temperature 0, `num_ctx 8192`, `num_predict 256`
and the system prompt; called with no options it answers exactly as the
`q4-opt` configuration.

Demo in the browser — `/order-extract` (linked from the home page): one chat
per configuration, the same e-mail sent to each; every answer shows the
fields against the expected order, whether the prompt fit the window or the
answer hit max tokens, time, speed and the model's memory.

Result: [docs/day29-local-optimization.md](docs/day29-local-optimization.md).

## Day 31 — developer assistant (`/help` about this project)

http://localhost:3000/dev-assistant (backend: `src/dev-assistant`,
`POST /dev-assistant/ask {message}`), or in the terminal:

```bash
npm run dev:mcp-weather                                        # the git MCP server must be up
npm run dev-help --workspace=backend                           # interactive, the prompt shows the branch
npm run dev-help --workspace=backend -- "/help где живёт RAG-пайплайн?"
```

- **RAG over the project's own docs** (`project-docs.ts`): every `README.md`,
  everything in `docs/`, the backend HTTP API generated from the Nest
  controllers (method, path, handler signature, doc comment — can't go stale)
  the data schemas (`*.types.ts`) and the iOS client's Swift sources
  (`ios/**/*.swift`). Structural chunks, the same local e5
  embeddings, hybrid search (vectors + BM25, RRF). Index in
  `backend/data/dev-assistant/index.json`; on start only changed files are
  re-embedded (by content hash), `/reindex` does it on demand.
- **MCP git server** (`mcp-weather/src/git.ts`, `POST /mcp/git`), read-only:
  `git_current_branch`, `git_status`, `git_list_files`, `git_diff`,
  `git_log`, `read_project_file`. The repository is the one the server runs
  from (`GIT_REPO_DIR` overrides it).
- **`/help <question>`**: branch + uncommitted changes (MCP) and the top-6
  documentation excerpts go to the model as project context; the git tools
  stay available for what the docs don't say (exact files, code, the
  branch's diff). The answer cites excerpts as `[n]`; the UI shows which
  excerpts were cited and every MCP call. `/help` alone = project overview.
- Shortcuts without the LLM: `/branch`, `/status`, `/files [dir]`,
  `/diff [base]`, `/docs`, `/reindex`. Plain text is treated as `/help`.

Env (backend): `DEV_ASSISTANT_MCP_URL` (default `http://localhost:3002/mcp/git`),
`DEV_ASSISTANT_MCP_TOKEN` (falls back to `MCP_AUTH_TOKEN`), `DEV_ASSISTANT_MODEL`
(default `LLM_MODEL`), `DEV_ASSISTANT_REPO_DIR` (default: the repo root).
See [docs/day31-dev-assistant.md](docs/day31-dev-assistant.md).
