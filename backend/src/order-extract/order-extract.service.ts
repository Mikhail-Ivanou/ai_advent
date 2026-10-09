import { Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { EMAILS, ExpectedOrder } from './dataset';
import { chat, Config, CONFIGS, Field, MODELS, ollama, OPT, Params, parseOrder, sameModel, scoreOrder } from './order-extract';
import { SYSTEM_PROMPT, userPrompt } from './prompt';

// Day 29 demo: one chat per configuration of the local model — the same
// e-mail sent to each shows what temperature, max tokens, the context window
// and the quantization change. Every message is extracted on its own (the
// task has no dialog): the system prompt + this e-mail, with the chat's
// parameters, straight to Ollama.

const DATA_FILE = path.resolve(__dirname, '../../data/order-extract-chats.json');

export interface Metrics {
  /** Without the model load. */
  totalMs: number;
  loadMs: number;
  /** Prompt tokens the model actually read — fewer than the prompt when it didn't fit the window. */
  promptTokens: number;
  /** The whole prompt, estimated (≈2.6 characters per qwen token here, ±10%). */
  promptEstimate: number;
  promptMs: number;
  outputTokens: number;
  outputMs: number;
  /** "stop", or "length" when the answer hit num_predict. */
  doneReason: string;
  /** The loaded model per `ollama ps`: weights + KV cache + buffers. */
  memoryBytes: number;
  contextLength: number;
}

export interface ExtractMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** user: the e-mail's date (relative dates count from it). */
  date?: string;
  /** user: the control e-mail this text is, if it is one — then the answer is checked. */
  exampleId?: string;
  /** assistant: the answer parsed as an order, when it is JSON. */
  order?: Record<string, unknown>;
  /** assistant: field -> correct, for a control e-mail. */
  check?: Record<Field, boolean>;
  metrics?: Metrics;
  error?: string;
}

export interface ExtractChat {
  id: string;
  title: string;
  configId: string;
  model: string;
  quant: string;
  /** What is sent to Ollama; anything unset is the model's / Ollama's default. */
  params: Params;
  messages: ExtractMessage[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class OrderExtractService {
  private chats = new Map<string, ExtractChat>();

  constructor() {
    if (fs.existsSync(DATA_FILE)) {
      for (const c of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as ExtractChat[]) this.chats.set(c.id, c);
    }
  }

  meta() {
    return {
      systemPrompt: SYSTEM_PROMPT,
      /** What order-extractor's Modelfile sets. */
      opt: OPT,
      configs: CONFIGS.map((c) => ({ ...c, modelName: MODELS[c.model].name, quant: MODELS[c.model].quant })),
      examples: EMAILS,
    };
  }

  list() {
    return [...this.chats.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ messages, ...c }) => ({ ...c, messages: messages.length }));
  }

  get(id: string): ExtractChat {
    const c = this.chats.get(id);
    if (!c) throw new NotFoundException(`Чат ${id} не найден`);
    return c;
  }

  create(configId: string): ExtractChat {
    const config: Config | undefined = CONFIGS.find((c) => c.id === configId);
    if (!config) throw new NotFoundException(`Конфигурация ${configId} не найдена`);
    const now = new Date().toISOString();
    const chat: ExtractChat = {
      id: `ox-${Date.now().toString(36)}`,
      title: config.label,
      configId,
      model: MODELS[config.model].name,
      quant: MODELS[config.model].quant,
      params: config.params,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.chats.set(chat.id, chat);
    this.save();
    return chat;
  }

  remove(id: string) {
    this.chats.delete(id);
    this.save();
    return { ok: true };
  }

  async send(id: string, body: { text: string; date: string }): Promise<ExtractChat> {
    const c = this.get(id);
    const example = EMAILS.find((e) => e.text === body.text.trim() && e.date === body.date);
    c.messages.push({ role: 'user', content: body.text, date: body.date, exampleId: example?.id, createdAt: new Date().toISOString() });
    c.messages.push(await this.extract(c, body, example?.expected));
    c.updatedAt = new Date().toISOString();
    this.save();
    return c;
  }

  private async extract(c: ExtractChat, email: { text: string; date: string }, expected?: ExpectedOrder): Promise<ExtractMessage> {
    const createdAt = new Date().toISOString();
    try {
      const res = await chat(c.model, email, c.params);
      const { models } = await ollama('/api/ps');
      const ps = (models ?? []).find((m: any) => sameModel(m, c.model));
      const content: string = res.message?.content ?? '';
      const order = parseOrder(content);
      return {
        role: 'assistant',
        content,
        createdAt,
        order,
        check: order && expected ? scoreOrder(order, expected) : undefined,
        metrics: {
          totalMs: ((res.total_duration ?? 0) - (res.load_duration ?? 0)) / 1e6,
          loadMs: (res.load_duration ?? 0) / 1e6,
          promptTokens: res.prompt_eval_count ?? 0,
          promptEstimate: Math.round((SYSTEM_PROMPT.length + userPrompt(email.date, email.text).length) / 2.6),
          promptMs: (res.prompt_eval_duration ?? 0) / 1e6,
          outputTokens: res.eval_count ?? 0,
          outputMs: (res.eval_duration ?? 0) / 1e6,
          doneReason: res.done_reason ?? '',
          memoryBytes: ps?.size ?? 0,
          contextLength: ps?.context_length ?? 0,
        },
      };
    } catch (error) {
      return { role: 'assistant', content: '', createdAt, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify([...this.chats.values()], null, 1));
    fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
  }
}
