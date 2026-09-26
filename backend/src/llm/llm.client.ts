export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A function the model may call, in OpenAI `tools` shape minus the wrapper. */
export interface LlmTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmToolExecution {
  content: string;
  isError: boolean;
  /** Where the call actually went — for the log, since `name` may have been disambiguated. */
  source?: { server: string; tool: string };
}

/** Tools offered to the model for one answer, plus how to run them (Day 17: backed by connected MCP servers). */
export interface LlmToolset {
  tools: LlmTool[];
  execute(name: string, args: Record<string, unknown>): Promise<LlmToolExecution>;
}

export interface ToolCallLog {
  name: string;
  server?: string;
  tool?: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
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
  /** Tools the model may call while answering. Ignored for JSON-format calls, which are internal extraction steps. */
  tools?: LlmToolset;
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
  /** Every tool call made while producing `content`, in order. */
  toolCalls?: ToolCallLog[];
}

// Upper bound on model <-> tool round trips per answer, so a model that keeps
// calling tools can't loop forever; the last round is sent with tool_choice
// "none" to force a final text answer.
const MAX_TOOL_ROUNDS = 5;

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
  const tools = options.format !== 'json' && options.tools?.tools.length ? options.tools : undefined;
  if (tools) {
    instructions.push(
      'You have tools that return real, up-to-date data. When the question needs such data (e.g. the weather), call the matching tool instead of guessing, then answer using what it returned. If a tool returns an error, tell the user plainly what went wrong.',
    );
    // Scheduling tools take relative delays; the model needs "now" to turn
    // "remind me at 18:00" into one.
    instructions.push(`Current date and time: ${new Date().toString()}.`);
  }

  const messages: Record<string, unknown>[] = [
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
            content: `This is an ongoing multi-step task, tracked as a controlled state machine (planning -> execution -> validation -> done, validation may return to execution for rework). Pick up exactly where it left off — do not re-ask for information already established. Two moves are hard-gated and must never be skipped, no matter how the user phrases the request or how confident they sound: do NOT begin execution (writing code, producing the actual implementation or deliverable) until the plan has been explicitly approved (see "План утверждён" below); do NOT mark the task done or hand over a final result until validation has explicitly passed (see "Валидация пройдена" below). If asked to jump ahead of an unmet gate, explicitly refuse that part, name which gate is blocking it, and say what's needed to unlock it — do not silently comply and do not silently ignore the request either. Current state: ${options.taskState}`,
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

  if (tools) {
    requestBody.tools = tools.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const requests: LlmRequestLog[] = [];
  const toolCalls: ToolCallLog[] = [];
  let usage: LlmUsage | undefined;
  let data: any;

  for (let round = 1; ; round++) {
    if (tools && round === MAX_TOOL_ROUNDS) requestBody.tool_choice = 'none';
    // Snapshot per round: `messages` keeps growing with tool results, and the
    // log must show exactly what each individual call sent.
    const body = { ...requestBody, messages: [...messages] };
    requests.push({ label: round === 1 ? label : `${label}:tool-round-${round}`, body });
    data = await postChatCompletion(apiUrl, apiKey, body);
    usage = sumUsage(usage, parseUsage(data.usage));

    const message = data.choices?.[0]?.message;
    const calls: any[] = tools && Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) break;

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: calls,
      // Reasoning models (DeepSeek) reject a tool round that drops their own reasoning.
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });
    for (const call of calls) {
      const name: string = call.function?.name ?? '';
      let args: Record<string, unknown> = {};
      let execution: LlmToolExecution;
      const started = Date.now();
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        execution = await tools!.execute(name, args);
      } catch (error) {
        execution = { content: `Tool call failed: ${(error as Error).message}`, isError: true };
      }
      toolCalls.push({
        name,
        server: execution.source?.server,
        tool: execution.source?.tool,
        arguments: args,
        result: execution.content,
        isError: execution.isError,
        durationMs: Date.now() - started,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: execution.content });
    }
  }

  let content: string = data.choices?.[0]?.message?.content ?? '';

  // Hard stop: truncate right after the stop sequence ourselves, since not every
  // provider honors an instruction to stop generating on its own.
  if (options.stopSequence) {
    const stopIndex = content.indexOf(options.stopSequence);
    if (stopIndex !== -1) {
      content = content.slice(0, stopIndex + options.stopSequence.length);
    }
  }

  return {
    content,
    model: data.model ?? model,
    usage,
    requests,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

async function postChatCompletion(apiUrl: string, apiKey: string, body: Record<string, unknown>): Promise<any> {
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const errorCause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const cause = errorCause instanceof Error ? `: ${errorCause.message}` : '';
    throw new Error(`Could not reach LLM API at ${apiUrl}${cause}`);
  }

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function parseUsage(raw: any): LlmUsage | undefined {
  return raw
    ? {
        promptTokens: raw.prompt_tokens ?? 0,
        completionTokens: raw.completion_tokens ?? 0,
        totalTokens: raw.total_tokens ?? 0,
      }
    : undefined;
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
        toolCalls: answer.toolCalls,
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
        toolCalls: results.flatMap((r) => r.toolCalls ?? []),
      };
    }

    case 'direct':
    default:
      return callLlm(task, options, 'direct');
  }
}
