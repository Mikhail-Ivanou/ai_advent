export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskOptions {
  /** Desired response format: freeform prose, or a single JSON object. */
  format?: 'text' | 'json';
  /** Upper bound on the number of tokens the model may generate. */
  maxOutputTokens?: number;
  /** Sequence/instruction that tells the model where to stop generating. */
  stopSequence?: string;
  /** Sampling temperature — lower is more deterministic, higher is more creative. */
  temperature?: number;
  /** Overrides LLM_MODEL for this call. */
  model?: string;
  /** Prior turns of the conversation, oldest first, to give the model context. */
  history?: ChatMessage[];
  /** Summary of older turns not included in `history` (see history compression). */
  summary?: string;
  /** Sticky-facts key-value memory, formatted as "key: value" lines. */
  facts?: string;
  /** Working memory: task-scoped data for the current chat only (see memory model, Day 11). */
  workingMemory?: string;
  /** Long-term memory: profile/decisions/knowledge that persists across chats (see memory model, Day 11). */
  longTermMemory?: string;
  /** This user's personalization profile — style/format/constraints (see Day 12). Formatted text, or undefined if none selected. */
  profile?: string;
  /** Formalized task state — stage/step/expected action (see Day 13). Formatted text, or undefined if no task is active. */
  taskState?: string;
  /** Hard invariants — architecture/decisions/stack/business rules the assistant must never propose violating (see Day 14). Formatted text, or undefined if none are active. */
  invariants?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmRequestLog {
  /** Which step produced this call, e.g. "direct", "self-prompt:generate", "expert-panel:Критик". */
  label: string;
  /** The exact JSON body sent to the API for this call — model, messages, and whichever of response_format/max_tokens/temperature applied. */
  body: Record<string, unknown>;
}

export interface LlmResult {
  content: string;
  model: string;
  usage?: LlmUsage;
  /** The exact request(s) sent to the API — one entry per underlying call this made. */
  requests: LlmRequestLog[];
}

/**
 * BYN price per 1M tokens for each model this account has access to
 * (from GET https://api.aiai.by/v1/models — update if pricing changes).
 */
const MODEL_PRICING_BYN_PER_1M: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.30338, output: 0.606759 },
  'deepseek-chat-v3': { input: 0.8427, output: 3.3708 },
  'kimi-k2.5': { input: 1.51686, output: 7.5843 },
  'deepseek-v4-pro': { input: 2.21528, output: 5.85993 },
  'gpt-3.5-turbo-instruct': { input: 5.0562, output: 6.7416 },
  'deepseek-r1-distill-llama-70b': { input: 2.69664, output: 2.69664 },
  'qwen-2.5-72b-instruct': { input: 1.21349, output: 1.34832 },
};

export function estimateCostByn(model: string, usage?: LlmUsage): number | undefined {
  const pricing = MODEL_PRICING_BYN_PER_1M[model];
  if (!pricing || !usage) return undefined;
  return (usage.promptTokens / 1_000_000) * pricing.input + (usage.completionTokens / 1_000_000) * pricing.output;
}

/**
 * Minimal OpenAI-compatible chat completion call.
 * Works with OpenAI, OpenRouter, Groq, and other providers exposing the same API shape —
 * just point LLM_API_URL/LLM_MODEL/LLM_API_KEY at the provider you want.
 * LLM_API_URL is the provider's base URL (e.g. https://api.openai.com/v1) —
 * "/chat/completions" is appended automatically.
 */
export async function callLlm(prompt: string, options: AskOptions = {}, label = 'direct'): Promise<LlmResult> {
  const baseUrl = (process.env.LLM_API_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiUrl = `${baseUrl}/chat/completions`;
  const apiKey = process.env.LLM_API_KEY;
  const model = options.model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set. Add it to backend/.env');
  }

  const instructions = ['Always reply in the same language the user wrote their message in.'];
  instructions.push(
    options.format === 'json'
      ? 'Respond with a single valid JSON object only — no prose, no markdown code fences.'
      : 'Respond in plain text — no JSON, no markdown formatting.',
  );
  if (options.stopSequence) {
    instructions.push(`Stop writing immediately after you output: "${options.stopSequence}"`);
  }

  const messages = [
    { role: 'system', content: instructions.join(' ') },
    // Placed before everything else, including personalization: these are
    // hard constraints on the solution space, not a preference — nothing
    // below (style, task, memory, the user's own request) can override them.
    ...(options.invariants
      ? [
          {
            role: 'system',
            content: `These are hard invariants for this project — non-negotiable constraints you must NEVER propose violating, no matter what is asked or how persistently. Before answering, check the request against every invariant below. If satisfying the request in full or in part would require breaking one, do not propose that part: explicitly refuse it, name which invariant blocks it, and — where possible — suggest an alternative that respects it instead. Do this even if the user insists, rephrases, or claims an exception applies.\n${options.invariants}`,
          },
        ]
      : []),
    // Placed first among the context blocks, ahead of memory: this is about
    // *how* to talk to this specific person, so it should color how the rest
    // of the context (memory, history) gets used, not compete with it.
    ...(options.profile
      ? [
          {
            role: 'system',
            content: `This user has a personalization profile — apply it to every response, automatically, without being asked again: ${options.profile}`,
          },
        ]
      : []),
    ...(options.taskState
      ? [
          {
            role: 'system',
            content: `This is an ongoing multi-step task, tracked as an explicit state machine — pick up exactly where it left off, do not re-ask for information already established, and do not silently skip or re-order stages: ${options.taskState}`,
          },
        ]
      : []),
    // Its own message (not folded into the instructions above) so the model
    // doesn't skim past it — this is the only record of everything that
    // happened before the messages below.
    ...(options.longTermMemory
      ? [
          {
            role: 'system',
            content: `Long-term memory — true across all conversations with this user, not just this one (profile, past decisions, general knowledge): ${options.longTermMemory}`,
          },
        ]
      : []),
    ...(options.summary
      ? [
          {
            role: 'system',
            content: `Summary of the earlier part of this conversation (older messages were dropped to save context — treat this as ground truth for what was said before): ${options.summary}`,
          },
        ]
      : []),
    ...(options.workingMemory
      ? [
          {
            role: 'system',
            content: `Working memory — data scoped to the current task in this chat only, not necessarily true elsewhere: ${options.workingMemory}`,
          },
        ]
      : []),
    ...(options.facts
      ? [
          {
            role: 'system',
            content: `Known facts about this conversation (key-value memory, updated as things change — treat this as ground truth): ${options.facts}`,
          },
        ]
      : []),
    ...(options.history ?? []),
    { role: 'user', content: prompt },
  ];

  const requestBody: Record<string, unknown> = { model, messages };

  if (options.format === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }
  if (options.maxOutputTokens) {
    requestBody.max_tokens = options.maxOutputTokens;
  }
  if (options.temperature !== undefined) {
    requestBody.temperature = options.temperature;
  }

  // Captured after every conditional field above, so this is byte-for-byte
  // what JSON.stringify(requestBody) below actually sends — not a parallel
  // reconstruction that could drift from the real body.
  const requestLog: LlmRequestLog = { label, body: requestBody };

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    const errorCause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const cause = errorCause instanceof Error ? `: ${errorCause.message}` : '';
    throw new Error(`Could not reach LLM API at ${apiUrl}${cause}`);
  }

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  let content: string = data.choices?.[0]?.message?.content ?? '';

  // Hard stop: truncate right after the stop sequence ourselves, since not every
  // provider honors an instruction to stop generating on its own.
  if (options.stopSequence) {
    const stopIndex = content.indexOf(options.stopSequence);
    if (stopIndex !== -1) {
      content = content.slice(0, stopIndex + options.stopSequence.length);
    }
  }

  const usage: LlmUsage | undefined = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      }
    : undefined;

  return { content, model: data.model ?? model, usage, requests: [requestLog] };
}

function sumUsage(a?: LlmUsage, b?: LlmUsage): LlmUsage | undefined {
  if (!a && !b) return undefined;
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
  };
}

export type ReasoningMode = 'direct' | 'step-by-step' | 'self-prompt' | 'expert-panel';

/**
 * Same task, four different reasoning strategies (see Day 3 exercise):
 * a plain answer, an explicit "think step by step" instruction, a prompt the
 * model writes for itself before solving, and a simulated expert panel.
 */
export async function callLlmWithReasoning(
  task: string,
  mode: ReasoningMode = 'direct',
  options: AskOptions = {},
): Promise<LlmResult> {
  switch (mode) {
    case 'step-by-step':
      return callLlm(
        `${task}\n\nРешай пошагово, подробно объясняя каждый шаг рассуждения.`,
        options,
        'step-by-step',
      );

    case 'self-prompt': {
      const generated = await callLlm(
        `Ты — эксперт по составлению промптов для решения задач.
Составь эффективный промпт-инструкцию, который поможет модели правильно и подробно решить задачу ниже.
Выведи только сам промпт (инструкцию), без решения самой задачи.

Задача: ${task}`,
        { model: options.model },
        'self-prompt:generate',
      );
      const answer = await callLlm(`${generated.content}\n\nЗадача: ${task}`, options, 'self-prompt:answer');
      return {
        content: `Сгенерированный промпт:\n${generated.content}\n\nОтвет:\n${answer.content}`,
        model: answer.model,
        usage: sumUsage(generated.usage, answer.usage),
        requests: [...generated.requests, ...answer.requests],
      };
    }

    case 'expert-panel': {
      const experts = [
        {
          role: 'Аналитик',
          persona: 'Ты — аналитик. Формально разбери условия и ограничения задачи, затем дай своё решение.',
        },
        {
          role: 'Инженер',
          persona: 'Ты — инженер. Предложи конкретный практический пошаговый способ решения задачи.',
        },
        {
          role: 'Критик',
          persona:
            'Ты — критик. Реши задачу, уделяя особое внимание поиску возможных ошибок и слабых мест в рассуждении.',
        },
      ];

      const results = await Promise.all(
        experts.map(({ role, persona }) =>
          callLlm(`${persona}\n\nЗадача: ${task}`, options, `expert-panel:${role}`),
        ),
      );

      return {
        content: experts.map(({ role }, index) => `${role}:\n${results[index].content}`).join('\n\n'),
        model: results[0]?.model ?? options.model ?? 'unknown',
        usage: results.reduce<LlmUsage | undefined>((acc, r) => sumUsage(acc, r.usage), undefined),
        requests: results.flatMap((r) => r.requests),
      };
    }

    case 'direct':
    default:
      return callLlm(task, options, 'direct');
  }
}
