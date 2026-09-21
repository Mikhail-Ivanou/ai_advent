import { LlmRequestLog, LlmUsage, callLlm, estimateCostByn } from './llm.client';

export type TaskStage = 'planning' | 'execution' | 'validation' | 'done';

export const TASK_STAGES: TaskStage[] = ['planning', 'execution', 'validation', 'done'];

// The finite automaton: which stage each stage may move to next. `validation`
// can bounce back to `execution` (the real-world "that didn't pass, redo it"
// case) — everything else only moves forward. `done` is terminal; starting a
// new task means resetting state entirely, not transitioning out of `done`.
const TASK_TRANSITIONS: Record<TaskStage, TaskStage[]> = {
  planning: ['execution'],
  execution: ['validation'],
  validation: ['execution', 'done'],
  done: [],
};

/**
 * Day 15: adjacency in TASK_TRANSITIONS is necessary but not sufficient —
 * two specific moves are additionally gated behind an explicit approval, so
 * the machine can't be talked into skipping the checkpoint that move exists
 * for:
 * - planning -> execution requires `planApproved` (no implementation before
 *   an approved plan).
 * - validation -> done requires `validationPassed` (no shipping the final
 *   result without validation actually passing).
 * Gates are omitted for a plain adjacency check (e.g. when only the shape of
 * the automaton matters, not a specific instance's state).
 */
export function isValidTaskTransition(
  from: TaskStage,
  to: TaskStage,
  gates?: Pick<TaskState, 'planApproved' | 'validationPassed'>,
): boolean {
  if (from === to) return true;
  if (!TASK_TRANSITIONS[from].includes(to)) return false;
  if (from === 'planning' && to === 'execution') return gates ? gates.planApproved : true;
  if (from === 'validation' && to === 'done') return gates ? gates.validationPassed : true;
  return true;
}

export interface TaskState {
  stage: TaskStage;
  /** One-line description of the overall task, so state is self-contained without re-reading the whole history. */
  goal: string;
  /** What's being worked on right now within the current stage. */
  step: string;
  /** What needs to happen next for the task to move forward — from either side, agent or user. */
  expectedAction: string;
  /** Frozen on purpose: while true, the update step is skipped entirely so nothing drifts while parked. */
  paused: boolean;
  /** Explicit gate (Day 15): must be true before planning -> execution is allowed. Set by an explicit approval action, never inferred loosely. */
  planApproved: boolean;
  /** Explicit gate (Day 15): must be true before validation -> done is allowed. Reset to false automatically on a validation -> execution rework loop, since the old pass no longer applies to the redone work. */
  validationPassed: boolean;
  updatedAt: string;
}

function formatTaskState(task: TaskState): string {
  const lines = [
    `Этап: ${task.stage}${task.paused ? ' (ПРИОСТАНОВЛЕНО)' : ''}`,
    `Цель задачи: ${task.goal}`,
    `Текущий шаг: ${task.step}`,
    `Ожидаемое действие: ${task.expectedAction}`,
    `План утверждён: ${task.planApproved ? 'да' : 'нет'}`,
    `Валидация пройдена: ${task.validationPassed ? 'да' : 'нет'}`,
  ];
  return lines.join('\n');
}

export { formatTaskState };

interface TaskUpdateResult {
  task: TaskState | null;
  changed: boolean;
  usage?: LlmUsage;
  costByn?: number;
  requests: LlmRequestLog[];
}

const VALID_STAGES: TaskStage[] = ['planning', 'execution', 'validation', 'done'];

/**
 * The explicit state-machine transition step: reads the exchange and decides
 * whether a multi-step task is in progress, and if so what its next
 * stage/step/expected-action should be — a formal, inspectable alternative to
 * "the model just remembers" (see Day 13). Never called while paused; the
 * caller is responsible for that gate.
 */
export async function updateTaskState(
  current: TaskState | null,
  userMessage: string,
  assistantAnswer: string,
  model?: string,
): Promise<TaskUpdateResult> {
  const prompt = `Ты отслеживаешь состояние многошаговой задачи пользователя как конечный автомат с контролируемыми переходами:
planning (планирование) → execution (выполнение) → validation (проверка результата) → done (завершено).
Из validation можно вернуться в execution, если проверка выявила проблему.

Два перехода заблокированы, пока не выполнено условие:
- planning → execution ЗАПРЕЩЁН, пока пользователь явно не утвердил план (просто "звучит неплохо" — недостаточно; нужно явное согласие продолжать).
- validation → done ЗАПРЕЩЁН, пока пользователь явно не подтвердил, что проверка/валидация пройдена успешно.

Текущее состояние:
${current ? formatTaskState(current) : '(задачи ещё нет — обычный разговор без выделенной многошаговой задачи)'}

Новый обмен репликами:
Пользователь: """${userMessage}"""
Ассистент: """${assistantAnswer}"""

Реши:
1. Если это НЕ похоже на многошаговую задачу (просто вопрос, болтовня, разовая просьба) — верни {"task": null}.
2. Если многошаговая задача только начинается — создай новое состояние с stage: "planning".
3. Если пользователь в этом сообщении явно утвердил план (например "план утверждён", "погнали", "делай так") — верни planApproved: true.
4. Если пользователь в этом сообщении явно подтвердил, что валидация/проверка прошла успешно — верни validationPassed: true.
5. Обнови step и expectedAction под текущий момент; переведи stage на следующий, ТОЛЬКО если для этого есть явное основание в диалоге И (если применимо) соответствующее условие выполнено. Никогда не перепрыгивай через этап и никогда не переводи planning→execution или validation→done без явного утверждения/подтверждения в этом же или более раннем сообщении.
6. Не трогай задачу (верни её как есть), если обмен репликами явно не связан с ней.

Верни ТОЛЬКО валидный JSON без пояснений и markdown, в формате:
{"task": null} или {"task": {"stage": "planning"|"execution"|"validation"|"done", "goal": "...", "step": "...", "expectedAction": "...", "planApproved": true|false, "validationPassed": true|false}}
planApproved/validationPassed — true, только если пользователь только что дал согласие в ЭТОМ сообщении; иначе false (уже действующее согласие из прошлых ходов сохраняется автоматически, тебе не нужно его повторять).`;

  const result = await callLlm(prompt, { model, format: 'json', temperature: 0.1, maxOutputTokens: 1500 }, 'task-state:update');
  const costByn = estimateCostByn(result.model, result.usage);

  let task = current;
  let changed = false;
  try {
    const parsed = JSON.parse(result.content);
    if (parsed && typeof parsed === 'object') {
      if (parsed.task === null) {
        // Explicit "no task" only takes effect the first time (nothing to clear
        // yet) — once a task exists, only an explicit transition or a manual
        // reset should get rid of it, not a single unrelated message.
        if (!current) task = null;
      } else if (
        parsed.task &&
        typeof parsed.task === 'object' &&
        VALID_STAGES.includes(parsed.task.stage) &&
        typeof parsed.task.goal === 'string' &&
        typeof parsed.task.step === 'string' &&
        typeof parsed.task.expectedAction === 'string'
      ) {
        const proposedStage = parsed.task.stage as TaskStage;
        const fromStage = current?.stage ?? 'planning';
        // Approval is sticky once granted — a turn that doesn't re-mention it
        // can never take it away, only a fresh rework loop resets validation
        // (handled below).
        const planApproved = (current?.planApproved ?? false) || parsed.task.planApproved === true;
        const provisionalValidationPassed = (current?.validationPassed ?? false) || parsed.task.validationPassed === true;

        const stage = !current || isValidTaskTransition(fromStage, proposedStage, { planApproved, validationPassed: provisionalValidationPassed })
          ? proposedStage
          : fromStage;

        // A rework loop (validation -> execution) invalidates the old
        // validation pass — the redone work hasn't been validated yet, even
        // though the flag that unlocked "done" last time is technically still
        // sitting there.
        const validationPassed = fromStage === 'validation' && stage === 'execution' ? false : provisionalValidationPassed;

        const next: TaskState = {
          stage,
          goal: parsed.task.goal,
          step: parsed.task.step,
          expectedAction: parsed.task.expectedAction,
          paused: false,
          planApproved,
          validationPassed,
          updatedAt: new Date().toISOString(),
        };
        changed = !current || JSON.stringify({ ...current, updatedAt: '' }) !== JSON.stringify({ ...next, updatedAt: '' });
        task = next;
      }
    }
  } catch {
    // Model didn't return valid JSON this turn — leave the task state as-is.
  }

  return { task, changed, usage: result.usage, costByn, requests: result.requests };
}
