export interface AskOptions {
  /** Desired response format: freeform prose, or a single JSON object. */
  format?: 'text' | 'json';
  /** Upper bound on the number of tokens the model may generate. */
  maxOutputTokens?: number;
  /** Sequence/instruction that tells the model where to stop generating. */
  stopSequence?: string;
}

/**
 * Minimal OpenAI-compatible chat completion call.
 * Works with OpenAI, OpenRouter, Groq, and other providers exposing the same API shape —
 * just point LLM_API_URL/LLM_MODEL/LLM_API_KEY at the provider you want.
 * LLM_API_URL is the provider's base URL (e.g. https://api.openai.com/v1) —
 * "/chat/completions" is appended automatically.
 */
export async function callLlm(prompt: string, options: AskOptions = {}): Promise<string> {
  const baseUrl = (process.env.LLM_API_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiUrl = `${baseUrl}/chat/completions`;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

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
      { role: 'user', content: prompt },
    ],
  };

  if (options.format === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }
  if (options.maxOutputTokens) {
    requestBody.max_tokens = options.maxOutputTokens;
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

  return content;
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
): Promise<string> {
  switch (mode) {
    case 'step-by-step':
      return callLlm(`${task}\n\nРешай пошагово, подробно объясняя каждый шаг рассуждения.`, options);

    case 'self-prompt': {
      const generatedPrompt = await callLlm(
        `Ты — эксперт по составлению промптов для решения задач.
Составь эффективный промпт-инструкцию, который поможет модели правильно и подробно решить задачу ниже.
Выведи только сам промпт (инструкцию), без решения самой задачи.

Задача: ${task}`,
      );
      const answer = await callLlm(`${generatedPrompt}\n\nЗадача: ${task}`, options);
      return `Сгенерированный промпт:\n${generatedPrompt}\n\nОтвет:\n${answer}`;
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

      const answers = await Promise.all(
        experts.map(({ persona }) => callLlm(`${persona}\n\nЗадача: ${task}`, options)),
      );

      return experts.map(({ role }, index) => `${role}:\n${answers[index]}`).join('\n\n');
    }

    case 'direct':
    default:
      return callLlm(task, options);
  }
}
