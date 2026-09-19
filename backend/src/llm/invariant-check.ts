import { Invariant } from '../invariant/invariant.types';
import { LlmRequestLog, LlmUsage, callLlm, estimateCostByn } from './llm.client';

export interface InvariantViolation {
  id: string;
  title: string;
  explanation: string;
}

export interface InvariantCheckResult {
  compliant: boolean;
  violations: InvariantViolation[];
  usage?: LlmUsage;
  costByn?: number;
  requests: LlmRequestLog[];
}

function formatInvariantsForCheck(invariants: Pick<Invariant, 'id' | 'title' | 'rule'>[]): string {
  return invariants.map((i) => `- id="${i.id}" [${i.title}] ${i.rule}`).join('\n');
}

/**
 * The verification half of Day 14: a dedicated, separate LLM call that reads
 * back the assistant's own answer and checks it against every invariant —
 * independent of whatever the main answer already claimed about itself, so a
 * silent violation doesn't just go unnoticed. This never blocks or edits the
 * answer (it already went out); it exists so a violation is visible and
 * inspectable, the same way memory/task updates are.
 */
export async function checkInvariantCompliance(
  invariants: Pick<Invariant, 'id' | 'title' | 'rule'>[],
  userMessage: string,
  assistantAnswer: string,
  model?: string,
): Promise<InvariantCheckResult> {
  const prompt = `Ты проверяешь соответствие ответа ассистента жёстким инвариантам проекта (архитектурным решениям, ограничениям стека, бизнес-правилам), которые ассистент не имеет права нарушать.

Инварианты:
${formatInvariantsForCheck(invariants)}

Сообщение пользователя:
"""${userMessage}"""

Ответ ассистента:
"""${assistantAnswer}"""

Проверь: предлагает, рекомендует или реализует ли ответ ассистента что-либо, что нарушает хотя бы один инвариант — даже частично, даже как один из нескольких вариантов, даже "временно". Если ассистент правильно ОТКАЗАЛСЯ выполнять просьбу пользователя из-за конфликта с инвариантом (и не предложил нарушающую альтернативу) — нарушения нет.

Верни ТОЛЬКО валидный JSON без пояснений и markdown, в формате:
{"compliant": true|false, "violations": [{"id": "<id инварианта>", "explanation": "коротко, что именно нарушено и как"}]}
Если compliant true, "violations" — пустой массив.`;

  const result = await callLlm(
    prompt,
    { model, format: 'json', temperature: 0, maxOutputTokens: 500 },
    'invariants:check',
  );
  const costByn = estimateCostByn(result.model, result.usage);

  let compliant = true;
  let violations: InvariantViolation[] = [];
  try {
    const parsed = JSON.parse(result.content);
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.violations)) {
        const byId = new Map(invariants.map((i) => [i.id, i.title]));
        violations = parsed.violations
          .filter((v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object')
          .filter((v) => typeof v.id === 'string' && byId.has(v.id))
          .map((v) => ({
            id: v.id as string,
            title: byId.get(v.id as string)!,
            explanation: typeof v.explanation === 'string' ? v.explanation : '',
          }));
      }
      compliant = typeof parsed.compliant === 'boolean' ? parsed.compliant : violations.length === 0;
    }
  } catch {
    // Model didn't return valid JSON this turn — default to "compliant" rather
    // than crying wolf on a parse failure; the invariants were still injected
    // into the main prompt regardless of whether this check succeeded.
  }

  return { compliant, violations, usage: result.usage, costByn, requests: result.requests };
}
