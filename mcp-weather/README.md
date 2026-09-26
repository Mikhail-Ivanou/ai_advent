# mcp-weather

MCP server with one tool, `get_weather_forecast`: current weather and a
forecast for a city, on top of [Open-Meteo](https://open-meteo.com). Open-Meteo
is free and needs no API key, so the only secret is the server's own bearer
token (`MCP_AUTH_TOKEN`).

Transport: Streamable HTTP, stateless, at `POST /mcp`. `GET /health` is a
plain health check.

## Tool

`get_weather_forecast`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `city` | string | — | City name in any language. Narrow it down with a country after a comma: `Париж, Франция`, `Paris, US` |
| `days` | integer 1–16 | 3 | Number of forecast days, starting today |
| `detail` | `daily` \| `hourly` | `daily` | `hourly` adds a forecast every 3 hours (capped at 7 days) |

It returns text for the model (current conditions, a row per day, and hourly
rows for `hourly`) plus `structuredContent` described by `outputSchema`. An
unknown city or an unreachable weather service comes back as a result with
`isError: true`, so the model can read the error and tell the user.

## Background tasks (scheduler)

The same server runs a scheduler with deferred and periodic tasks. It lives
inside the server process, so on a VM it runs 24/7, independently of the app.

| Tool | Purpose |
|---|---|
| `schedule_task` | create a task: `weather_watch` (collect the weather every `interval_minutes` and send an aggregated summary every `summary_every_minutes`) or `reminder` (once after `delay_minutes`, or repeating) |
| `list_scheduled_tasks` | the chat's tasks: schedule, status, run count, latest result |
| `get_task_summary` | aggregate over the collected samples: min/max/average temperature, trend, precipitation, prevailing weather |
| `set_task_status` | `paused` / `active` / `cancelled` |
| `get_task_events` | what the tasks produced: reminders, summaries, errors (`after_seq` — only newer ones) |

- **Storage:** everything is kept in `data/scheduler.json`: tasks, samples (up
  to 2,000 per task) and events (up to 1,000). Docker keeps it on the
  `weather_data` volume, so it survives rebuilds. Writes go through a temporary
  file followed by a rename, so a crash can't leave a truncated file.
- **Linking to a chat:** the client sends the chat id in the request's
  `_meta["advent/chatId"]`; the model neither sees nor sets it. Without `_meta`
  (e.g. the backend's poller) the tools see every chat's tasks and events.
- **Execution:** a check runs every `SCHEDULER_TICK_MS` (15 s by default). After
  downtime, a task runs once and then keeps its normal cadence; missed runs are
  not replayed as a burst.

## Pipeline: search → summarize → save_to_file

Three tools that pass data **by id**, not as text. Each step stores its result
on the server (`data/pipeline.json`) and returns an id, and the next step takes
that id. So the model doesn't retype text between steps, which means it can't
distort it and doesn't spend tokens on it. Each result also records its
source's id and sha256, so the chain can be checked end to end.

| Tool | Input → output |
|---|---|
| `search` | `query`, `sources` (a list from `habr`, `wikipedia`, `hackernews`; default `["habr", "wikipedia"]`), `lang`, `limit` (per service) → `doc_id` + list of what it found, labelled by source |
| `summarize` | `source_id` (= `doc_id`), `style` (`brief` \| `bullets` \| `detailed`), `max_words` → `summary_id` + text |
| `save_to_file` | `source_id` (= `summary_id` or `doc_id`), `format` (`md` \| `txt` \| `json`), `filename` → file, size, sha256, link |
| `run_pipeline` | the same chain in one call, strictly in order; returns a log of steps with a hash check at every handoff |

- **Sources:** Habr (the JSON API its own site uses, full article text), the
  Wikipedia API (article introductions), and Hacker News (via Algolia). One
  call queries all the listed services **in parallel** and merges their
  results into one document, alternating by rank (Habr #1, Wikipedia #1,
  Habr #2, …) so that no source crowds out another. If one service is down,
  the search returns the others' results and reports the failure.
- **`summarize` needs no API keys.** It's extractive: it scores sentences by
  word frequency (ignoring common words), by position in the text and by
  overlap with the query, skips near-duplicates, and keeps sentences in their
  original order.
- **Checks:** every read compares the stored sha256. `save_to_file` re-reads
  the file from disk and checks that it contains exactly the text it was
  given. A chat sees only its own artifacts (`_meta["advent/chatId"]`).
- **Download:** `GET /files/<name>` with the bearer token, or via the link from
  `save_to_file`. That link carries a signature of that particular filename
  (HMAC with the token as the key), so it opens in a browser without the
  header, opens only that file, and doesn't reveal the token. The link needs
  `PUBLIC_BASE_URL` in `.env`.

## Local run

```bash
cp mcp-weather/.env.example mcp-weather/.env   # MCP_AUTH_TOKEN can stay empty locally
npm run dev:mcp-weather                         # http://localhost:3002/mcp
```

In the app: **MCP** (bottom left) → URL `http://localhost:3002/mcp`,
protocol "Авто". If a token is set, add the header
`Authorization: Bearer <token>`.

## Deploy to h3llo.cloud

h3llo.cloud is IaaS (VMs, disks, networking), with no managed container
service, so the server runs in Docker on a VM.

1. In the h3llo.cloud console, create a VM (e.g. `ubuntu:24.04`) with a public
   IP (Elastic IP) and an SSH key. Open inbound TCP `3002`, or `80`/`443` if you
   use TLS.
2. On the VM:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone <repo-url> advent && cd advent/mcp-weather
   cp .env.example .env
   sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$(openssl rand -hex 32)/" .env
   docker compose up -d --build
   curl http://localhost:3002/health
   ```
3. If the tool answers «Сервис погоды недоступен: … timeout», `api.open-meteo.com`
   can't be reached from the VM's network. That's the case on h3llo.cloud: TCP to
   its address doesn't go through, while Open-Meteo's other hosts work. Set an
   alternative host that serves the same data in `.env` and restart the server:
   ```bash
   sed -i "s|^OPEN_METEO_FORECAST_URL=.*|OPEN_METEO_FORECAST_URL=https://previous-runs-api.open-meteo.com/v1/forecast|" .env
   docker compose up -d
   ```
4. Connect it in the app: URL `http://<vm-ip>:3002/mcp` and the header
   `Authorization: Bearer <token from .env>`.

### With HTTPS (recommended)

Without TLS the token travels in plain text. If you have a domain whose A
record points to the VM:

```bash
# in .env: DOMAIN=weather.example.com, WEATHER_BIND=127.0.0.1
docker compose --profile tls up -d --build
```

Caddy gets a Let's Encrypt certificate on its own. The URL in the app is then
`https://weather.example.com/mcp`.

### Update

```bash
git pull && docker compose up -d --build
```

`.env` is in `.gitignore` and `.dockerignore`, so it never ends up in the
repository or the image. Its variables are passed to the container at start
time through `env_file`.
