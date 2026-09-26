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
