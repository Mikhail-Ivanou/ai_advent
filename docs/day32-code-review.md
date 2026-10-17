# Day 32 — AI code review of pull requests

Every pull request gets a review comment from the assistant. The comment lists potential bugs, architecture problems and recommendations, each pointing to a line of the diff.

```
pull_request ─► GitHub Action (.github/workflows/ai-review.yml)
                 │ checkout PR head, fetch base
                 ▼
          npm run review (backend/src/review)
                 │
   git diff merge-base..head ──► batches of files
                 │                    │
                 │   RAG over docs + code, two searches per file:
                 │     · by meaning: path + added lines
                 │     · definitions: what the added lines call
                 ▼                    ▼
         LLM (JSON findings) ◄── annotated diff + small files in full + context
                 │
   check findings against the diff ─► Markdown report ─► PR comment (updated on push)
                                                         + job summary + artifact
```

## Pipeline

**Diff.** `git diff` is taken from the merge-base with the base branch, which is what GitHub shows for a PR. It comes with rename detection and 5 lines of context.

The diff is parsed into hunks with new-file line numbers. Skipped files:
- lockfiles;
- `.pbxproj`;
- `dist`, `build`, `.next`;
- binaries.

Locally, `--worktree` reviews the working copy instead of a commit, including untracked files.

**RAG: documentation and code.** The Day 31 index gained a `code` group with the TypeScript sources of backend, web, mcp-weather and llm-gateway. It now holds 117 files and about 1,040 chunks. `/help` still searches only the documentation.

The first build embeds about 750 code chunks, which took 53 s on an M1 Pro. After that only changed files are re-embedded. For each changed file the review runs two searches:

| Search | Query | Finds |
|---|---|---|
| by meaning | file path + added lines (hybrid: e5 vectors + BM25) | the docs about that part of the project; similar code elsewhere (duplication, conventions) |
| definitions | functions, methods and `snake_case` ids the added lines call | where they are defined: signatures, `async`, schema limits (`max(100)`), what already exists |

The definition lookup is literal regex matching (`function x`, a method `x(…) {`, `'x',` in `registerTool`):
- BM25 splits `git_log` into `git` + `log`;
- embeddings blur identifiers.

Without it, the context for the demo PR below held neither the `git_log` schema nor `ensure()`. With it, both were found and the model caught both bugs.

The PR's own files are kept out of the context, because the diff already shows them.

This report is excluded from the context too (`EXCLUDED_CONTEXT`; `REVIEW_EXCLUDE_CONTEXT` adds more paths). It lists the problems planted in the demo PR, and once it was indexed the review found all six by reading this table instead of the code. Without it, the result is 4 bugs found precisely (#1–#4) and #5 as a recommendation.

**LLM.** Each batch of files (about 40k characters of diff) gets one call. The prompt contains:
- the context;
- small changed files (≤ 16k characters) in full, with line numbers;
- the diff with every line prefixed by its new-file number.

The model returns `{summary, findings[]}`. Each finding has a category (`bug` / `architecture` / `recommendation`), a severity, a file and line, a title, details, a suggestion, and the context items it relies on.

**Checks.**
- A finding about a file not in the diff is dropped.
- A finding pinned to a line outside the changed hunks is dropped: it is about old code. The report says how many were dropped.
- `[n]` references are replaced with file names, because the PR reader doesn't see the numbering.
- Duplicates are removed.
- Findings are sorted by severity.

`deepseek-v4-flash` spends hidden reasoning tokens before it answers. With `max_tokens: 4000`, a real batch came back empty. The limit is now 16k, with one retry at 32k. If a batch still fails, the report is built from the other batches and names the files it could not review.

**Report.** It has a summary, the counts, three sections, and links to `blob/<head sha>/<file>#L<line>`. A collapsed "Как сделано ревью" block lists:
- the files;
- what was skipped or dropped;
- the RAG sources;
- the model, tokens and time.

## GitHub Action

`.github/workflows/ai-review.yml` runs on:
- `pull_request`: opened, synchronize, reopened, ready_for_review; drafts are skipped;
- `workflow_dispatch` with a PR number.

Steps:
1. Check out the PR head with full history and fetch the base branch.
2. Run `npm ci` for the backend workspace.
3. Restore the embedding model and the project index from the Actions cache.
4. Run `npm run review` with `--repo-url`/`--sha` for links.
5. `actions/github-script` creates the comment, or updates it in place by its `<!-- ai-code-review -->` marker, and writes the job summary. `review.md` and `review.json` are uploaded as an artifact.

| Setting | |
|---|---|
| `secrets.LLM_API_KEY` | required. Without it, e.g. on a PR from a fork, the comment says the review was skipped. |
| `vars.LLM_API_URL` | OpenAI-compatible base URL, e.g. `https://api.aiai.by/v1` |
| `vars.REVIEW_MODEL` | default `deepseek-v4-flash` |
| `vars.REVIEW_FAIL_ON` | `high` / `medium`: the check fails (exit 2) on a bug of that severity; the comment is still posted |

Permissions are `contents: read` and `pull-requests: write`. `concurrency` cancels a stale run when a new push arrives.

## Demo: a PR with planted problems

The PR is one commit on top of Day 31 (2 files, +19 −1). It adds a `/log` command and auto-refresh of the branch badge, with six planted problems:

| # | Problem | Needs context from the project |
|---|---|---|
| 1 | `/log` defaults to `limit` 500, but the `git_log` schema allows at most 100 | `mcp-weather/src/git.ts` |
| 2 | `/reindex`: `this.docs.ensure(true)` without `await`, then reads `stats` | `ensure()` returns a Promise |
| 3 | `setInterval` in `useEffect` without cleanup | — |
| 4 | `.slice(1, limit)` "skips the header", but `git_log` output has no header: the newest commit is lost | `git_log` output format |
| 5 | `parseInt(arg) \|\| 500`: `/log 0` gives 500 | — |
| 6 | `countWords` duplicates the tokenizer in `rag/lexical.ts` | `backend/src/rag/lexical.ts` |

| Model | Found | Time | Notes |
|---|---|---|---|
| `ollama/qwen2.5:7b` | 0 of 6 | 38 s | two vague "recommendations" |
| `ollama/gemma3:12b`, first version of the context | 1 of 6 (#3, as "too frequent requests") | 118 s | the rest was generic advice; about ten findings on unchanged lines (these were kept then, now they are dropped) |
| **`deepseek-v4-flash`**, with definition lookup | **5 of 6** (#1–#5) | 35 s, 16k tokens | #1 and #2 cite the context files (`git.ts`, `project-docs.ts`); #4 was reported as losing the "Коммитов нет." line; #6 was missed (the tokenizer was not in the context) |

What made the difference:
- The definition lookup put the `git_log` schema and `ensure()` into the context. #1 and #2 cannot be seen from the diff alone.
- The model. Local 7–12B models do follow the JSON format, but they write general advice instead of reading the code.

In the developer assistant, `/review [base]` renders the same report as formatted Markdown (`web/src/components/ReviewMarkdown.tsx`).

## Self-review

The review of Day 32's own changes (`--base task31 --worktree`): 8 files, +921 lines, 2 batches, 124 s, 52k tokens, 11 findings.

Some of these were useful:
- incomplete regex escaping in `findDefinitions` (fixed);
- two batch summaries glued into one paragraph (each is now a separate line);
- `checkRef`/`SAFE_REF` duplicated between `mcp-weather/src/git.ts` and `review/git-diff.ts`. These are different npm packages; left as is.

Some were false:
- "the diff parser loses a line on `\ No newline at end of file`". The parser deliberately does not count it.
- "`new CodeReviewer()` in the CLI will crash without an argument". The constructor has a default.

The reviewer is an assistant: a finding with a plausible explanation can still be wrong, which is why every finding links to its line.
