# Day 33 — support assistant

A support assistant for **Advent LLM**: our own private LLM service, made of llm-gateway and the LLM Chat iOS app. It answers users' questions about the product. Each answer combines the user's and the ticket's data from a CRM over MCP with the FAQ through RAG.

```
ticket T-1041 ─► CRM (MCP /mcp/crm): ticket thread, user card (plan, devices, key status),
                 other tickets, gateway events per device
                        │
question ─► RAG query = question + error codes + key status ─► FAQ / product docs, top-5
                        │
                        ▼
              LLM (support instructions + CRM data + FAQ [n]) ─┬─► answer: cause from the data + steps + [n]
                        ▲                                      └─► "передать сотруднику: да/нет — зачем"
              CRM read tools for anything else
                                                     "Отправить в тикет" ─► crm_add_ticket_reply (MCP)
```

## Data

**FAQ** (`docs/support/faq.md`) is written for users. It covers:
- connection settings;
- why `localhost` doesn't work on an iPhone;
- what 401 / 429 / 503 / 400 / 404 / 502 / 504 mean;
- how to reissue a key;
- plans and their limits;
- privacy;
- when a human gets involved.

The support RAG also reads the llm-gateway and iOS READMEs. It has its own index (`backend/data/support/index.json`), separate from the developer assistant's.

**CRM** (`mcp-weather/crm/seed.json`):
- 5 users;
- 6 tickets;
- the gateway's events per device: time, the last 4 characters of the key, status, error code and repeat count. Message text is not stored there, and the FAQ says so.

Each user has a different cause behind a similar complaint:

| Ticket | User | Says | Actual cause, visible only in the data |
|---|---|---|---|
| T-1041 | Анна, «Команда» | "почему не работает авторизация? на ноутбуке работает" | iPhone key `…a91f` revoked 14.10 after a reissue (T-1032); the Mac already has the new `…7c2e` |
| T-1042 | Борис, «Пробный» | "почему не работает авторизация? ключ не трогал" | trial ended 12.10, key `…3d08` disabled (`trial_expired`); 401 since 13.10 |
| T-1043 | Карина, «Базовый» | "не работает авторизация, не удалось подключиться; поставила localhost" | not the key: there are no requests from her device at all. It worked only from the office network (`192.168.10.24`), now she's at home with no VPN, and `localhost` points at the phone itself |
| T-1044 | Дмитрий, «Базовый» | "скрипт получает 429, авторизация отваливается?" | the rate limit: bursts of 20 OK, then 429 ×27/×31, plan limit 20/min |
| T-1045 | Ольга, «Команда» | "пишет «Диалог не помещается», что сломалось?" | the conversation grew to 8410 tokens out of 8192 |

## MCP: `advent-crm`

| Tool | |
|---|---|
| `crm_find_user` | by email, name, company or id |
| `crm_get_user` | plan with limits, subscription, devices: key status `active` / `revoked` / `disabled` with date and reason, last successful request; staff note |
| `crm_list_tickets` | by user and/or status |
| `crm_get_ticket` | the thread and internal notes (marked as not to be shown to the user) |
| `crm_get_gateway_events` | events per device. If a device sent nothing in the last 7 days, the tool says so explicitly: requests don't reach the server |
| `crm_add_ticket_reply` | a reply to the user or an internal note, optionally with a new status |
| `crm_list_users` | all users, for the "new request" form |
| `crm_create_ticket` | a new ticket from a user: subject and first message, id continues `T-NNNN` |

The model gets only the read tools, and not `crm_list_users`: it works on one user and has no reason to see the others.

## How an answer is put together

The backend lives in `backend/src/support`.
1. **CRM, before the model.** It reads the ticket, the user card, their other tickets and the gateway events. This is deterministic: the model always sees the facts and doesn't have to remember to ask for them.
2. **RAG.** The query is the question plus the error codes from the events plus the key statuses. "почему не работает авторизация" on its own matches every paragraph about keys. With "401 invalid_api_key revoked" it finds the one about a reissued key; with "429 rate_limit_exceeded" it finds the one about limits.
3. **LLM.** The instructions are:
   - first name the cause with a concrete fact (device, key, date, code);
   - no events at all means a connection problem, not the key;
   - compare the network the user connected from before with where they write from now;
   - then give steps, citing the FAQ `[n]`;
   - if the question doesn't match the real cause, say so gently.

   Restrictions: don't quote staff notes, full keys or other users' data. Don't promise what only staff do (reissuing a key, changing a plan). End with "ПЕРЕДАТЬ СОТРУДНИКУ: да/нет — зачем". The CRM's read tools stay available for anything more.
4. **UI** (`/support`):
   - ticket list from the CRM, newest first;
   - "+ Новое обращение" to simulate an incoming request: pick a user, a message (or one of the templates), optionally a subject (default: the first sentence), channel and priority. The ticket is created through `crm_create_ticket`, opened, and its message is ready to ask;
   - the ticket thread;
   - the assistant's answer as a draft with an escalation badge, which can be edited and sent to the ticket;
   - the user card with keys per device;
   - the gateway events;
   - collapsible blocks showing the FAQ excerpts and the CRM data the answer was given with.

## Runs (`deepseek-v4-flash`, 4–13 s, ~4–5k tokens)

| Ticket | Answer | Human |
|---|---|---|
| T-1041 | "на iPhone остался старый ключ …a91f, отозван 14 октября после перевыпуска (T-1032); на MacBook уже новый …7c2e — вставьте его в настройки iPhone" | no |
| T-1042 | "ключ …3d08 правильный, но отключён: пробный период закончился 12.10, с 13.10 сервер отвечает 401; после оплаты ключ включится сам" | yes, payment |
| T-1043, first version of the prompt | caught `localhost`, but suggested looking up "the server's IP on your home network" | no ❌ |
| T-1043, after adding "сравни сеть" | "дело не в ключе: сервер в сети офиса, из дома без VPN не подключиться даже с правильным адресом; плюс localhost — это сам телефон" | yes, VPN |
| T-1044 | "это не авторизация: 429 — лимит 20 запросов/мин на «Базовом», скрипт шлёт пачками; пауза 3–4 с или тариф «Команда»" | no |
| T-1045 | "ничего не сломалось: диалог дорос до 8410 токенов при лимите 8192 — «Новый чат», перескажите главное, длинное частями" | no |
| T-1046, created in the UI from Дмитрий: "хочу подключить ещё один iPhone" | "на «Базовом» до 2 устройств, оба заняты (iPhone …51bb и скрипт …0f4a); нужен тариф «Команда» — 10 устройств и 60 запросов/мин, заодно уйдут 429 у скрипта; тариф меняет сотрудник" | yes, plan change |
| `--user olga.kim@…`, no ticket | "тариф «Команда»: до 10 устройств, 60 запросов/мин; подписка до 1 декабря" | no |

On T-1045 the model once added that the old chat "можно открыть из истории". The app has no chat history. The FAQ said nothing either way, so the model filled the gap. The FAQ now states that history is not kept after "Новый чат".

"Отправить в тикет" was checked on T-1044. The answer was written through `crm_add_ticket_reply`, the ticket became "ждём пользователя", and it shows up in the thread after a reload.

## Found along the way

`McpEndpointClient`, the MCP client shared by the developer assistant and support, was leaking. The SDK's HTTP transport sends every request with its one AbortSignal, and each fetch leaves a listener on it. After 100 calls Node printed `MaxListenersExceededWarning`, and the listeners kept piling up for the life of the connection. The client now reopens its connection every 50 calls (the servers are stateless). 300 calls in a row now produce no warnings.

The agent chat's `McpService` (Day 16) uses the same transport and probably leaks the same way. It was not changed here.
