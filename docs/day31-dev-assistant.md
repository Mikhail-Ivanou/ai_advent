# Day 31 — developer assistant

An assistant that knows this repository: `/help <question>` answers from the
project's own documentation (RAG) and from its live git state (MCP).

- UI: http://localhost:3000/dev-assistant. It shows the branch in the header,
  the MCP tools and the indexed files in the sidebar, and under each answer
  the excerpts it got and every MCP call it made.
- Terminal: `npm run dev-help --workspace=backend`.
- API: `POST /dev-assistant/ask {message, history?, model?}`.

```
/help <question>
  │
  ├─ MCP git (mcp-weather /mcp/git) ── git_current_branch + git_status ──┐
  ├─ RAG over the project docs ─────── top-6 excerpts + README overview ─┼─► LLM ─► answer with [n]
  └─ git tools for the model: list files, read file, diff, log ──────────┘    (it calls them itself)
```

## What is indexed (RAG)

The corpus is collected from the repository each time the backend starts, so
there is no list to maintain. 20 files, 265 chunks:

| Group | Files |
|---|---|
| READMEs | `README.md`, `mcp-weather/`, `llm-gateway/`, `ios/LLMChat/` |
| docs | `docs/*.md`: the day reports |
| API | `backend/API.md`, generated from the Nest controllers. Each route gets its method, full path, handler signature with body/param types, and doc comment, so it always matches the code. |
| Data schemas | `backend/src/**/*.types.ts`: RAG index and chunks, RAG chat and `TaskMemory`, MCP servers, memory, profiles, invariants |

How it is built:
- Chunks are structural: one per heading or top-level declaration, as on Day 21.
- Embeddings use the same local `multilingual-e5-small`. The file path is embedded with the chunk, so "llm-gateway README" can be told apart from "mcp-weather README".
- Search is hybrid (vectors + BM25, RRF).

The index is stored in `backend/data/dev-assistant/index.json`. A restart re-embeds only files whose content hash changed: 0 of 20 when nothing changed (77 ms), and `/reindex` after editing the README took a few seconds.

The two opening chunks of the root README ("Structure" and "Getting
started") are added to every `/help` context. A Russian question like "как
запустить проект?" does not reliably reach the English "Getting started" by
similarity: it ranked below report chunks that mention running something.

The local cross-encoder from Day 23 was tried as a reranker and dropped. On
Russian questions against English and TypeScript chunks it made results
worse. For "какие поля у TaskMemory" it pushed the `rag-chat.types.ts` chunk
out of the top 3, where plain hybrid search ranked it #2.

## MCP: `advent-git`

`mcp-weather/src/git.ts` serves `POST /mcp/git` from the same process as the
weather, scheduler and research servers. It is read-only: `git` runs through
`execFile` (no shell) with fixed subcommands, refs are validated, paths come
after `--`, and `read_project_file` serves only tracked files whose real path
is inside the repository.

| Tool | What it returns |
|---|---|
| `git_current_branch` | branch, HEAD (sha, subject, date), upstream ahead/behind; also as `structuredContent` |
| `git_status` | uncommitted changes (porcelain) |
| `git_list_files` | tracked files, filtered by directory or substring, or a directory tree with file counts (`depth`) |
| `git_diff` | working copy vs HEAD, or the branch vs `base` (merge-base); `stat_only` for the file list |
| `git_log` | recent commits, optionally for a path |
| `read_project_file` | a file of the working copy with line numbers, in pages |

The backend connects to this server with its own small MCP client
(`git-mcp.client.ts`) rather than through the agent chat's user-managed
servers, because the assistant needs it all the time. The client keeps one
lazy connection and reconnects once if a call fails.

## Commands

| Command | LLM | What it does |
|---|---|---|
| `/help <question>` | yes | Puts the branch, uncommitted changes and doc excerpts into the context. The model may call the git tools and cites excerpts as `[n]`. |
| `/help` | yes | The same for "what is this project, its parts, how to run it" |
| `/branch` | no | `git_current_branch` |
| `/status` | no | `git_status` |
| `/files [dir]` | no | directory tree, 2 levels |
| `/diff [base]` | no | changed files (stat) |
| `/docs`, `/reindex` | no | what is indexed; rebuild |

Plain text without a command is treated as `/help`.

## Runs

The cloud model (`deepseek-v4-flash` via api.aiai.by) was unreachable from this
machine during the check (TLS error at the network level), so these runs use
the local `ollama/qwen2.5:7b` on an M1 Pro.

| Question | MCP calls | Result | Time |
|---|---|---|---|
| `/help как запустить проект локально и какие порты у каждой части?` | — | Correct: `npm install`, the four `dev:*` scripts and the ports 3001 / 3000 / 3002 / 8088. The answer came from the always-included README overview. | 37 s |
| `/help какие эндпоинты у rag-chat и где лежит их код?` | `read_project_file(rag-chat.controller.ts)` | All 7 routes, with the correct file | 37 s |
| `/help где реализован RAG-пайплайн и из каких шагов он состоит?` | `git_list_files` ×2, `read_project_file` ×2 | Correct: `backend/src/rag/rag-pipeline.ts`, `runPipeline`, rewrite → hybrid → rerank → threshold → top-K. It first tried a non-existent `rag.ts`, got an error, listed the directory and found the right file. | 145 s |
| `/help какие файлы сейчас изменены в рабочей копии…` | `git_status` | Listed the changed files. One attribution was wrong: it put `.claude/launch.json` under "backend". | 40 s |

The first version of the prompt let the 7B model name files from memory, for
example a `backend/src/rag/rag.ts` that does not exist. Adding "never name a
path that isn't in the excerpts or a tool result, confirm it with the
file-list tool" fixed this: in the run above the model checked the path and
corrected itself.

The local model rarely writes `[n]` even when it uses an excerpt, so the
"cited" marks in the UI are mostly empty with it. The file names it gives come
from tool results, which the UI shows in full.
