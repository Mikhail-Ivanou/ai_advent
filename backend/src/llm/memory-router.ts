import { MemoryCategory } from '../memory/memory.types';
import { LlmRequestLog, LlmUsage, callLlm, estimateCostByn } from './llm.client';

export interface MemoryRouterResult {
  /** Full, replaced working-memory set for the chat (existing keys kept unless the model overwrote them). */
  working: Record<string, string>;
  /** Only the long-term facts that are new or changed this turn — never the whole store. */
  longTerm: { category: MemoryCategory; key: string; value: string }[];
  usage?: LlmUsage;
  costByn?: number;
  requests: LlmRequestLog[];
}

function formatWorking(working: Record<string, string>): string {
  const entries = Object.entries(working);
  if (entries.length === 0) return '(пусто)';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

const VALID_CATEGORIES: MemoryCategory[] = ['profile', 'decision', 'knowledge'];

/**
 * The explicit "what goes where" decision at the heart of the memory model:
 * a dedicated LLM call that reads one exchange and sorts anything worth
 * keeping into working memory (this task only) or long-term memory
 * (profile/decisions/knowledge, kept across chats) — never both, and never
 * silently dropped into a single undifferentiated bag.
 */
export async function routeMemory(
  existingWorking: Record<string, string>,
  existingLongTermText: string | undefined,
  userMessage: string,
  assistantAnswer: string,
  model?: string,
): Promise<MemoryRouterResult> {
  const prompt = `Ты — модуль памяти диалогового агента. Раздели новую информацию из этого обмена репликами на два раздельных слоя памяти:

1. РАБОЧАЯ память — данные, нужные только для решения текущей задачи в ЭТОМ чате: параметры, промежуточные результаты, текущая цель, черновые варианты. Она не должна храниться вечно и не имеет смысла в других разговорах.
2. ДОЛГОВРЕМЕННАЯ память — то, что стоит помнить и в других разговорах: устойчивые факты профиля пользователя (имя, роль, предпочтения), принятые решения, общие знания.

Текущая рабочая память этого чата:
${formatWorking(existingWorking)}

${existingLongTermText ? `Уже сохранено в долговременной памяти:\n${existingLongTermText}\n\n` : ''}Новый обмен репликами:
Пользователь: """${userMessage}"""
Ассистент: """${assistantAnswer}"""

Верни ТОЛЬКО валидный JSON без пояснений и markdown, в формате:
{"working": {"ключ": "значение"}, "longTerm": [{"category": "profile" | "decision" | "knowledge", "key": "...", "value": "..."}]}

Правила:
- "working" — ПОЛНЫЙ обновлённый набор рабочей памяти (существующие ключи, которые ещё актуальны для задачи, + новые/изменённые). Убирай ключ, только если задача, к которой он относился, явно завершена или отменена.
- "longTerm" — ТОЛЬКО новые или изменившиеся факты (не повторяй то, что уже сохранено и не изменилось). Если ничего нового нет — верни пустой массив.
- Если для одного из слоёв ничего нет, верни пустой объект/массив для него, а не выдумывай данные.`;

  const result = await callLlm(prompt, { model, format: 'json', temperature: 0.1, maxOutputTokens: 600 }, 'memory:route');
  const costByn = estimateCostByn(result.model, result.usage);

  let working = existingWorking;
  let longTerm: { category: MemoryCategory; key: string; value: string }[] = [];
  try {
    const parsed = JSON.parse(result.content);
    if (parsed && typeof parsed === 'object') {
      if (parsed.working && typeof parsed.working === 'object' && !Array.isArray(parsed.working)) {
        working = Object.fromEntries(Object.entries(parsed.working).map(([key, value]) => [key, String(value)]));
      }
      if (Array.isArray(parsed.longTerm)) {
        longTerm = parsed.longTerm
          .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object')
          .filter((item) => item.key && item.value)
          .map((item) => ({
            category: VALID_CATEGORIES.includes(item.category as MemoryCategory)
              ? (item.category as MemoryCategory)
              : 'knowledge',
            key: String(item.key),
            value: String(item.value),
          }));
      }
    }
  } catch {
    // Model didn't return valid JSON this turn — keep working memory as-is, propose nothing new.
  }

  return { working, longTerm, usage: result.usage, costByn, requests: result.requests };
}
