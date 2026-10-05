# Day 26 — local LLM

**Setup:** Ollama 0.35.1 (Homebrew, `brew services`), model `qwen2.5:7b`
(Q4, 4.7 GB), Apple M1 Pro, 32 GB.

## It runs and can be reached

| Way in | Request | Answer |
| --- | --- | --- |
| Ollama CLI | `ollama run qwen2.5:7b "Скажи 'привет' одним словом."` | Здравствуй. |
| HTTP, native API | `POST :11434/api/generate` — "2+2=? Ответь числом." | 4 |
| HTTP, OpenAI-compatible | `POST :11434/v1/chat/completions` (via `npm run ask -- --model ollama/qwen2.5:7b`) | below |
| Backend | `POST :3001/llm/ask` with `"model": "ollama/qwen2.5:7b"` | "Меркурий, Венера, Земля", `costByn: 0`; the side JSON step (`task-state:update`, `response_format: json_object`) also ran locally |

## Three requests of different complexity

| # | Request | Time | Tokens | Result |
| --- | --- | --- | --- | --- |
| 1 | Fact: "Столица Франции? Ответь одним словом." | 0.5 s | 57 | "Париж" — correct |
| 2 | Explanation: "Объясни простыми словами, чем TCP отличается от UDP, в 3-4 предложениях." | 4.8 s | 159 | Correct in substance, but at the default temperature it switched to Chinese mid-answer. Three reruns at `temperature: 0.3`: clean Russian every time |
| 3 | Reasoning: two trains, 360 km, 60 km/h from 9:00 and 90 km/h from 10:00 — "Реши пошагово." | 19.6 s | 530 | 5 correct steps (60 km head start → 300 km left → 150 km/h closing speed → 2 h) → **12:00**, correct |

## Notes

- Speed is fine for short answers; long reasoning takes tens of seconds
  (~25–30 tokens/s generation on M1 Pro).
- 7B model weaknesses show up immediately: language drift (Chinese) on
  free-form text at temperature 1 — use a lower temperature with it.

## qwen2.5:7b vs gemma3:12b

Same three requests, same system prompt, OpenAI-compatible endpoint, model
already loaded; each model at the default temperature and at 0.3.

| | qwen2.5:7b | gemma3:12b |
| --- | --- | --- |
| Size on disk | 4.7 GB | 8.1 GB |
| Generation speed | ~21 tok/s | ~9.5 tok/s |
| 1. Capital of France | "Париж", 0.5 s | "Париж.", 1.2–1.4 s |
| 2. TCP vs UDP, default temperature | **switched to Chinese** mid-answer (again) | clean Russian, 8.6 s |
| 2. TCP vs UDP, temperature 0.3 | clean Russian, 4.8 s | clean Russian, with analogies and examples, 12.8 s |
| 3. Trains, default temperature | 12:00 correct, 18.6 s | 12:00 correct, 34.7 s |
| 3. Trains, temperature 0.3 | **11:00 — wrong**: got the 2 h right, then added them to 9:00 instead of 10:00 | 12:00 correct, 33.4 s |
| JSON mode (`response_format`) | works | works |
| Tool calling (MCP) | works — called `get_weather`, answered from its result | **not supported**: Ollama returns 400 "does not support tools" |

**Takeaways**

- gemma3:12b is the more reliable of the two: no language drift, correct
  reasoning in all 4 runs, better-written explanations. It costs ~2x the
  memory and is ~2x slower.
- qwen2.5:7b is fast but unstable: in 4 runs it drifted to Chinese twice (at
  temperature 1) and once made an arithmetic slip in the last step (at 0.3) —
  lowering the temperature fixes one problem but not the other.
- gemma3 cannot use tools. `callLlm` now retries such a request without tools
  instead of failing the turn, but the model then answers from its own
  knowledge — asked "Какая погода в Минске?" it made up a forecast. For
  MCP scenarios use qwen2.5:7b (or a larger tool-capable model).

## Chat UI run: local vs cloud (deepseek-v4-pro)

The same three questions in the chat UI (`/chat`), one chat per model, each
with everything extra off (MCP tools, invariants, task state, memory) so a
turn is exactly one LLM call; temperature 0.7.

| | deepseek-v4-pro (cloud) | gemma3:12b (local) | qwen2.5:7b (local) |
| --- | --- | --- | --- |
| 1. Capital of France | "Париж", 4.3 s | "Париж.", 9.2 s (incl. loading the model) | "Париж", 6.5 s |
| 2. TCP vs UDP | clean Russian, "registered letter vs postcard" analogy, 5.5 s | clean Russian, with examples, 12.8 s | **switched to Chinese** after the first sentence, 3.0 s |
| 3. Trains | **12:00** correct, short derivation, 10.0 s | **12:00** correct, 37.8 s | **11:00 wrong** (added 2 h to 9:00), 26.0 s |
| Tokens (API) for 3 answers | 1144 | 921 | 996 |
| Cost for 3 answers | 0.0053 BYN | 0 | 0 |

**Takeaways**

- deepseek-v4-pro matches gemma3:12b on quality (both 3/3) and is ~4x faster
  on the reasoning task; its answers are also more concise.
- On the trains task the API counted 743 tokens for a 167-token answer and a
  65-token question — the gap appears to be hidden reasoning, which is billed too.
  Still about half a kopeck for all three answers.
- gemma3:12b is a usable free, offline substitute for simple tasks; qwen2.5:7b
  only makes sense where tool calling is needed.
- With the extras on (MCP, invariants, task state, memory), the first question
  on qwen2.5:7b took 24 s and 3701 tokens over 4 calls instead of ~1 call — on
  a local model the side calls cost a lot, keep them off.
