# Changelog

## Дни 30–33 (9–17 октября 2026)

### Day 30 — Private LLM Service (`llm-gateway`)

**Commit:** `782287a` (9 окт 2026)

Создан приватный LLM-сервис — шлюз (gateway) поверх локальной Ollama, доступный по сети.

**Новые файлы:**
- `llm-gateway/` — полностью новый MCP-сервер:
  - `src/index.ts` — основной сервер Express: health, `/v1/models`, `/v1/chat/completions` (plain + streaming), live-лог
  - `src/config.ts` — конфигурация из переменных окружения
  - `src/ollama.ts` — клиент к Ollama через `/api/chat` с `truncate: false`
  - `src/limits.ts` — rate limiter (N запросов/мин на клиент)
  - `src/logs.ts` — сбор логов запросов
  - `src/logs-page.ts` — HTML-страница live-лога
  - `README.md`, `package.json`, `tsconfig.json`, `.env.example`
- `docs/day30-private-llm-service.md` — отчёт с проверками 10 сценариев
- `docs/img/day30-live-logs.png` — скриншот live-лога
- `ios/LLMChat/` — SwiftUI iOS-клиент для чата с gateway (ChatView, ChatViewModel, GatewayClient, SettingsView, LLMChatApp)
- `ios/LLMChat/README.md`

**Изменено:**
- `mcp-weather/README.md` — дополнение про новый сервер

**Ключевые возможности:**
- OpenAI-совместимое API (`/v1/chat/completions`)
- Проверка контекста: точное количество токенов через Ollama, 400 при превышении лимита
- Очередь (1 активный + 8 в очереди → 503)
- Rate limit (N/мин на клиент → 429)
- Аутентификация по API-ключу (Bearer)
- Live-лог на `GET /logs`

---

### Day 31 — Developer Assistant

**Commit:** `68b615c` (17 окт 2026)

Ассистент разработчика, знающий репозиторий: RAG по документации + MCP-доступ к git.

**Новые файлы:**
- `backend/src/dev-assistant/`:
  - `dev-assistant.controller.ts` — `POST /dev-assistant/ask`, эндпоинты `/dev-assistant/...`
  - `dev-assistant.service.ts` — основная логика: выбор команды, сбор RAG-контекста, вызов LLM
  - `dev-assistant.module.ts` — модуль NestJS
  - `project-docs.ts` — построение RAG-индекса по документам, README, API, типам, Swift-файлам
  - `git-mcp.client.ts` — MCP-клиент для git-сервера
  - `dev-help-cli.ts` — CLI-интерфейс (`npm run dev-help`)
- `backend/src/mcp/endpoint-client.ts` — MCP-клиент для HTTP-эндпоинтов
- `backend/src/llm/llm.client.ts` — универсальный клиент LLM
- `mcp-weather/src/git.ts` — MCP-сервер `advent-git` (read-only git-инструменты)
- `web/src/app/dev-assistant/page.tsx` — UI ассистента
- `docs/day31-dev-assistant.md` — отчёт

**Изменено:**
- `backend/src/app.module.ts` — подключение модуля DevAssistant
- `backend/src/rag/loaders.ts` — поддержка новых типов файлов (Swift, .types.ts)
- `backend/package.json` — зависимости
- `web/src/app/page.tsx` — ссылка на /dev-assistant
- `README.md` — секция про dev-assistant

**Дополнительный коммит:** `33669c4` — индексация Swift-исходников iOS-приложения в RAG-корпус.

**Команды ассистента:**
- `/help <вопрос>` — RAG + MCP git, ответ с цитатами
- `/branch`, `/status`, `/files`, `/diff` — git-инструменты без LLM
- `/docs`, `/reindex` — управление индексом

---

### Day 32 — AI Code Review

**Commit:** `9459125` (17 окт 2026)

Автоматическое ревью пулл-реквестов через AI: анализ diff, RAG по коду и документации, отчёт с finding'ами.

**Новые файлы:**
- `backend/src/review/`:
  - `reviewer.ts` — основной класс CodeReviewer: получение diff, RAG-контекст, вызов LLM, проверка finding'ов
  - `git-diff.ts` — парсинг diff с контекстом (merge-base), фильтрация файлов
  - `render.ts` — форматирование Markdown-отчёта
  - `review-cli.ts` — CLI (`npm run review` с опциями)
- `.github/workflows/ai-review.yml` — GitHub Action на `pull_request` + `workflow_dispatch`
- `web/src/components/ReviewMarkdown.tsx` — React-компонент для отображения отчёта в UI
- `docs/day32-code-review.md` — отчёт

**Изменено:**
- `backend/src/app.module.ts` — подключение ReviewModule
- `backend/package.json` — зависимости
- `web/src/app/page.tsx` — ссылка на /review

**Дополнительный коммит:** `fee4c40` — демо-репорт исключён из контекста RAG; отображение `/review` в UI.

**Как работает:**
1. Получение diff от merge-base до head
2. RAG-поиск: по смыслу (путь + добавленные строки) и по определениям (вызываемые функции)
3. LLM возвращает JSON с finding'ами (bug/architecture/recommendation)
4. Пост-обработка: удаление finding'ов вне изменённых строк, проверка файлов, сортировка
5. Публикация отчёта как PR-комментария (с обновлением при push)

---

### Day 33 — Support Assistant

**Commit:** `79d9a4e` (17 окт 2026)

Ассистент поддержки для продукта «Advent LLM»: CRM через MCP + FAQ через RAG.

**Новые файлы:**
- `backend/src/support/`:
  - `support.controller.ts` — `GET/POST /support/...`
  - `support.service.ts` — логика: сбор CRM-данных, RAG-поиск, вызов LLM
  - `support.module.ts` — модуль NestJS
  - `support-cli.ts` — CLI-интерфейс
- `mcp-weather/src/crm.ts` — MCP-сервер `advent-crm` (пользователи, тикеты, события gateway)
- `mcp-weather/crm/seed.json` — тестовые данные: 5 пользователей, 6 тикетов
- `docs/support/faq.md` — пользовательский FAQ (ошибки, настройка, планы, конфиденциальность)
- `web/src/app/support/page.tsx` — UI поддержки
- `docs/day33-support-assistant.md` — отчёт

**Изменено:**
- `backend/src/mcp/endpoint-client.ts` — фикс утечки слушателей AbortSignal (переоткрытие соединения каждые 50 вызовов)
- `backend/src/app.module.ts` — подключение SupportModule
- `mcp-weather/src/index.ts`, `mcp-weather/src/server.ts` — регистрация CRM-сервера
- `mcp-weather/Dockerfile`, `mcp-weather/.env.example` — обновление

**CRM-инструменты MCP:**
- `crm_find_user`, `crm_get_user`, `crm_list_tickets`, `crm_get_ticket`
- `crm_get_gateway_events`, `crm_add_ticket_reply`, `crm_create_ticket`

**Сценарии в тестовых данных (6 тикетов с разными проблемами):**
- T-1041: отозванный ключ на iPhone
- T-1042: истёкший пробный период
- T-1043: localhost вместо сетевого адреса
- T-1044: rate limit (429) на «Базовом» тарифе
- T-1045: превышение контекстного окна (8410 из 8192)
- T-1046: запрос второго устройства на «Базовом» тарифе

---

### Инфраструктурные изменения за дни 30–33

- `package.json`, `package-lock.json` — новые зависимости
- `.gitignore` — расширен
- `backend/.env.example` — шаблон переменных окружения
- `.claude/launch.json` — конфигурация для Claude Desktop
