# llm-gateway

A private AI service built on a local model: Ollama runs the model, and this
gateway is the only way in from the network.

```
client ──HTTP, Bearer key──▶ llm-gateway :8088 (0.0.0.0) ──▶ Ollama :11434 (127.0.0.1 only)
```

What the gateway adds on top of Ollama, which by itself listens only on
localhost, has no keys, no rate limits and silently cuts a long prompt from
the start:

| | |
|---|---|
| API | OpenAI-compatible `POST /v1/chat/completions` (plain and `stream: true` SSE), `GET /v1/models`, so any OpenAI client works with `base_url=http://<host>:8088/v1` |
| Chat | the client sends the whole history in `messages` (system/user/assistant); the server is stateless |
| Access | `Authorization: Bearer <key>`; keys are named per client in `GATEWAY_KEYS` |
| Rate limit | `RATE_LIMIT_PER_MINUTE` per client (sliding minute) → `429` + `Retry-After`, `X-RateLimit-*` headers |
| Load | `MAX_CONCURRENT` generations at once, a queue of `MAX_QUEUE` behind them, then `503 server_busy` + `Retry-After` |
| Max context | the model is always loaded with `num_ctx = MAX_CONTEXT_TOKENS`; a longer conversation gets `400 context_length_exceeded` with its exact token count (Ollama's `truncate: false`) |
| Max output | `max_tokens` is capped at `MAX_OUTPUT_TOKENS`; hitting it gives `finish_reason: "length"` |
| Robustness | a client that hangs up stops its generation and frees the slot; `REQUEST_TIMEOUT_MS` caps a single answer; body size and message count are limited |

`GET /health` (no key) reports Ollama reachability, the current load and the
limits. Every request is logged as one line: client, model, outcome, tokens,
time in queue, total time.

## Run

```bash
brew services start ollama                       # Ollama on 127.0.0.1:11434
cp llm-gateway/.env.example llm-gateway/.env      # then fill GATEWAY_KEYS:
#   GATEWAY_KEYS=owner:$(openssl rand -hex 24),laptop:$(openssl rand -hex 24)
npm run dev:llm-gateway                           # prints the LAN addresses it listens on
```

For a long-running service: `npm run build --workspace=llm-gateway && npm run start --workspace=llm-gateway`,
and keep the Mac awake (`caffeinate -s`, or Energy settings → prevent sleep on power).

## Use

```bash
curl http://<host>:8088/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Привет!"}],"temperature":0.3}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://<host>:8088/v1", api_key=KEY)
client.chat.completions.create(model="qwen2.5:7b", messages=[{"role": "user", "content": "Привет!"}])
```

`model` is optional (`DEFAULT_MODEL`); only `ALLOWED_MODELS` are accepted.
Supported parameters: `temperature`, `top_p`, `seed`, `stop`,
`presence_penalty`, `frequency_penalty`, `max_tokens` / `max_completion_tokens`,
`stream`, `stream_options.include_usage`. Tools are not passed through.

## Live log page

`http://localhost:8088/logs` shows every `/v1/chat/completions` call as it
happens, rejected ones included, over SSE:

- **Request:** time, client (the `X-Client-Name` header and the key's name),
  the last user message, model, number of messages, whether it streams.
- **State:** in the queue → generating (with a live character count) → HTTP
  status and outcome (`OK`, `rate limit`, `очередь полна`, `контекст превышен`,
  `клиент ушёл`, …).
- **Response size:** characters, tokens, bytes on the wire, prompt tokens.
- **Timing:** total time, time in the queue, time to the first token.

The header shows how many requests are generating and queued, the total
count, rejections and the average time. The page keeps the last 300
requests in memory, so they're gone after a restart. It's open without a key
from the Mac itself. From another device, add `?key=<gateway key>`, because
the log contains user messages.

## Errors

OpenAI shape, `{"error": {"message", "type", "code", ...}}`:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | bad body, no messages, too many messages |
| 400 | `context_length_exceeded` | the conversation doesn't fit; carries `prompt_tokens` and `max_context_tokens` |
| 401 | `invalid_api_key` | no or wrong key |
| 404 | `model_not_found` | model not installed or not allowed |
| 413 | `request_too_large` | body over `MAX_BODY_BYTES` |
| 429 | `rate_limit_exceeded` | client over its per-minute limit |
| 503 | `server_busy` | queue full or waited longer than `QUEUE_TIMEOUT_MS` |
| 502 | `upstream_unavailable` / `upstream_error` | Ollama is down or failed |
| 504 | `timeout` | generation exceeded `REQUEST_TIMEOUT_MS` |

## Notes

- Reachable on the local network only. Traffic is plain HTTP, so the key
  travels unencrypted. To reach the service from outside, use a VPN such as
  Tailscale, or put TLS in front (Caddy, as in `mcp-weather`) before
  forwarding a port.
- The model is loaded with `num_ctx = MAX_CONTEXT_TOKENS`. The backend's
  `ollama/*` models use Ollama's default context, so alternating between the
  two makes Ollama reload the model (a few seconds).
- Keep `MAX_CONCURRENT` at or below Ollama's `OLLAMA_NUM_PARALLEL`; above it,
  Ollama queues the extra requests itself, outside the gateway's control. On
  one M1 Pro, 1 is the right value: parallel generation splits the same GPU.
