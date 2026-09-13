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
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  content: string;
  model: string;
  usage?: LlmUsage;
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
export async function callLlm(prompt: string, options: AskOptions = {}): Promise<LlmResult> {
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

  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: instructions.join(' ') },
      ...(options.history ?? []),
      { role: 'user', content: prompt },
    ],
  };

  if (options.format === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }
  if (options.maxOutputTokens) {
    requestBody.max_tokens = options.maxOutputTokens;
  }
  if (options.temperature !== undefined) {
    requestBody.temperature = options.temperature;
  }

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

  return { content, model: data.model ?? model, usage };
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
      return callLlm(`${task}\n\nРешай пошагово, подробно объясняя каждый шаг рассуждения.`, options);

    case 'self-prompt': {
      const generated = await callLlm(
        `Ты — эксперт по составлению промптов для решения задач.
Составь эффективный промпт-инструкцию, который поможет модели правильно и подробно решить задачу ниже.
Выведи только сам промпт (инструкцию), без решения самой задачи.

Задача: ${task}`,
        { model: options.model },
      );
      const answer = await callLlm(`${generated.content}\n\nЗадача: ${task}`, options);
      return {
        content: `Сгенерированный промпт:\n${generated.content}\n\nОтвет:\n${answer.content}`,
        model: answer.model,
        usage: sumUsage(generated.usage, answer.usage),
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
        experts.map(({ persona }) => callLlm(`${persona}\n\nЗадача: ${task}`, options)),
      );

      return {
        content: experts.map(({ role }, index) => `${role}:\n${results[index].content}`).join('\n\n'),
        model: results[0]?.model ?? options.model ?? 'unknown',
        usage: results.reduce<LlmUsage | undefined>((acc, r) => sumUsage(acc, r.usage), undefined),
      };
    }

    case 'direct':
    default:
      return callLlm(task, options);
  }
}
