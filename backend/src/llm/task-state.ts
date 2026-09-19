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

export function isValidTaskTransition(from: TaskStage, to: TaskStage): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
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
  updatedAt: string;
}

function formatTaskState(task: TaskState): string {
  const lines = [
    `Этап: ${task.stage}${task.paused ? ' (ПРИОСТАНОВЛЕНО)' : ''}`,
    `Цель задачи: ${task.goal}`,
    `Текущий шаг: ${task.step}`,
    `Ожидаемое действие: ${task.expectedAction}`,
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
  const prompt = `Ты отслеживаешь состояние многошаговой задачи пользователя как конечный автомат с этапами:
planning (планирование) → execution (выполнение) → validation (проверка результата) → done (завершено).
Из validation можно вернуться в execution, если проверка выявила проблему.

Текущее состояние:
${current ? formatTaskState(current) : '(задачи ещё нет — обычный разговор без выделенной многошаговой задачи)'}

Новый обмен репликами:
Пользователь: """${userMessage}"""
Ассистент: """${assistantAnswer}"""

Реши:
1. Если это НЕ похоже на многошаговую задачу (просто вопрос, болтовня, разовая просьба) — верни {"task": null}.
2. Если многошаговая задача только начинается — создай новое состояние с stage: "planning".
3. Если задача уже идёт — обнови step и expectedAction под текущий момент; переведи stage на следующий, ТОЛЬКО если для этого есть явное основание в диалоге (план согласован → execution; шаги выполнены и пользователь просит проверить/подтвердить → validation; пользователь подтвердил, что всё готово → done). Никогда не перепрыгивай через этап.
4. Не трогай задачу (верни её как есть), если обмен репликами явно не связан с ней.

Верни ТОЛЬКО валидный JSON без пояснений и markdown, в формате:
{"task": null} или {"task": {"stage": "planning"|"execution"|"validation"|"done", "goal": "...", "step": "...", "expectedAction": "..."}}`;

  const result = await callLlm(prompt, { model, format: 'json', temperature: 0.1, maxOutputTokens: 400 }, 'task-state:update');
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
        const stage = !current || isValidTaskTransition(fromStage, proposedStage) ? proposedStage : fromStage;
        const next: TaskState = {
          stage,
          goal: parsed.task.goal,
          step: parsed.task.step,
          expectedAction: parsed.task.expectedAction,
          paused: false,
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
