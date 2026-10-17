# Day 34 — an assistant that works on project files

`/task <goal>` in the developer assistant, or `npm run file-task -- "<goal>"`. The assistant gets a goal ("check that every env var is documented"), not "open file X". It finds the files itself, reads them, compares them, and prepares changes. The changes come back as a diff and are written to disk only on request.

```
goal ─► LLM with tools (up to 30 rounds)
          ├─ MCP git, read: search_code · git_list_files · read_project_file · git_log · git_diff
          └─ local: edit_file · create_file ──► changeset (in memory, on top of get_file_raw)
                                                   │
                       report + unified diff ◄─────┘   saved: data/file-tasks/<id>.json + .patch
                                                   │
             "Применить" / --apply-run [--only] ──► MCP write_project_file (expected_sha1)
```

## Tools

The MCP server `git` (`mcp-weather/src/git.ts`) gained:

| Tool | |
|---|---|
| `search_code` | `git grep` over tracked and new non-ignored files: text or regex, path, file mask, case. Returns `path:line: text` and counts |
| `get_file_raw` | raw content + sha1 (or `exists: false`). For the backend; the model doesn't get it |
| `write_project_file` | create or overwrite a file in the working copy. `expected_sha1`: the content the change was based on (`new` for a new file); a mismatch means a conflict and the write is refused. Writes into `.git`, `node_modules`, build output and `.env*` (except `.env.example`) are refused, and the nearest existing parent must really lie inside the repository |

`/help` gets only the read tools. `write_project_file` is called only by the backend, on "Apply".

The agent (`backend/src/file-agent`):
- **`edit_file(path, old_text, new_text, replace_all?)`**: exact replacement. The fragment must occur exactly once, otherwise the model gets an error asking for more context. `create_file(path, content, overwrite?)` creates a file.
- **Changeset.** The edits go into a changeset, not onto disk. `read_project_file` of an edited file returns the draft, so the model sees its own edits. Each edit returns its diff to the model.
- **Diff.** `diff.ts` is a unified diff without dependencies (LCS over the changed middle). Its output was checked with `git apply`: a modification, a replacement and a new file in subdirectories.
- **Apply.** It writes through MCP with sha1 checks. `paths` applies only some files of a run. Status is `applied`, `partially-applied` or `failed`, and a repeated apply is refused.
- **Saved runs.** Every run is saved: goal, report, files read, searches, tool calls, changes, `.patch`.

## Scenarios (`deepseek-v4-flash`)

| # | Goal | What the agent did | Result |
|---|---|---|---|
| 1 | "Найди все места, где используется `McpEndpointClient`: кто создаёт/наследует, к каким серверам подключается, какие инструменты вызывает. Файлы не меняй." | 7 searches (plain name, `extends`, `new`, `import`, tool lists on the server side), read 8 files | A report with `path:line`: the class, `GitMcpClient extends`, `new McpEndpointClient` in support, a table of 13 CRM calls with lines, and both servers' tool lists. No files changed. 56 s. One mistake: it listed its own `edit_file`/`create_file` among the `git` server's tools |
| 2 | "Каждая переменная окружения, которую читает backend, должна быть в `backend/.env.example` с комментарием и значением по умолчанию из кода. Допиши недостающие." | a regex search for `process.env.*`, read 15 files (where each one is read and its default), one `edit_file` | Found 12 undocumented ones (`MCP_TOOL_TIMEOUT_MS`, `LLM_MAX_TOOL_ROUNDS`, `BACKGROUND_POLL_MS`, 4× `RAG_*`, `REVIEW_*`, `FILE_AGENT_MAX_ROUNDS`…) and added them grouped by module (+28 −3). Checked by `grep`: the code reads 22 variables and all are now covered. **Applied** |
| 3 | "Документация MCP-сервера git отстала от кода: сверь список инструментов с README и docs, обнови. Отчёты `docs/dayNN-*.md` не меняй." | 10 searches across `*.md`, read `git.ts` and the documents, edits in 3 files | Correctly found the 3 new tools and the outdated "read-only" in `mcp-weather/README.md`, `README.md`, and in `docs/day31-dev-assistant.md`, **which the goal said not to touch**. Applied with `--only` on the two READMEs; the Day 31 report was left unchanged |
| 4 | "Сгенерируй CHANGELOG.md по истории коммитов и docs/ за дни 30–34." (in the UI) | `git_log`, read the reports for days 30–33, `create_file` | 99 lines, mostly accurate, but with errors: the "Day 34" section describes commit `fee4c40` from Day 32 (Day 34 isn't committed yet; it didn't look at `git_status`), a wrong comment marker (`ai-review` instead of `ai-code-review`). **Not applied**. The template in the UI now says days 30–33 |
| 5 | "Создай docs/support/README.md: оглавление docs/support" (in the UI) | read `faq.md`, `create_file` | Applied with the button, file created. It was a check of the button and was deleted afterwards |

What this shows:
- **Scenario 2 is where the agent helps most.** Checking a rule across the whole code is tedious by hand, and the agent found everything and wrote it in the file's own style.
- **The changes have to be drafts.** In scenarios 3 and 4 a correct-looking diff contained a violation of the goal or wrong facts. The diff, partial apply and refusing to apply are exactly what caught them.
- **Cost.** A long exploration costs: 114k–343k prompt tokens per goal, because every round resends the whole conversation with the read files.

## Safety

- Writes go only through `write_project_file`, and only after the user's action.
- The sha1 check catches a file edited in the meantime. A test: a hand-made `CHANGELOG.md` created between the run and "Apply" gave `failed` with the message "Конфликт: … изменился после подготовки изменения", and the file was left alone.
- Found along the way: `checkPath` in `git.ts` (since Day 31) cut `../x` down to `./x`, so its check let such paths through. The realpath checks behind it caught `../../…`, but `../outside.txt` was written into the repository root. The fix strips only a leading `./`. `../x`, `../../etc/passwd` and `a/../../x` are now refused at once.
