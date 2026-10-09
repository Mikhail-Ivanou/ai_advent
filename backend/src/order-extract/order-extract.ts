import { ExpectedOrder } from './dataset';
import { SYSTEM_PROMPT, userPrompt } from './prompt';

// Day 29: what the order-extract CLI and the demo chats (/order-extract) share —
// the model builds, the configurations, the call to Ollama and the check of
// an answer against the expected order.

export const OLLAMA = (process.env.LOCAL_LLM_API_URL ?? 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');

export const MODELS = {
  q3: { name: 'qwen2.5:7b-instruct-q3_K_M', quant: 'Q3_K_M' },
  q4: { name: 'qwen2.5:7b', quant: 'Q4_K_M' },
  q8: { name: 'qwen2.5:7b-instruct-q8_0', quant: 'Q8_0' },
  // The result: Q4_K_M with OPT and SYSTEM_PROMPT baked in (--modelfile, then ollama create).
  extractor: { name: 'order-extractor', quant: 'Q4_K_M' },
};

export interface Params {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
}

export interface Config {
  id: string;
  label: string;
  model: keyof typeof MODELS;
  /** Only what is set here is sent; the rest is Ollama's / the model's default. */
  params: Params;
}

// The optimized parameters: temperature 0 — extraction has one right answer;
// num_ctx 8192 — the longest prompt is ≈5.1k tokens (Ollama's default here is
// the model's whole 32k window); num_predict 256 — the largest order is 115
// tokens of JSON, the cap only cuts off a runaway answer.
export const OPT: Params = { temperature: 0, num_ctx: 8192, num_predict: 256 };

export const CONFIGS: Config[] = [
  { id: 'q4-default', label: 'до: Q4_K_M, параметры по умолчанию', model: 'q4', params: {} },
  { id: 'q4-t0', label: 'Q4_K_M, только temperature 0', model: 'q4', params: { temperature: 0 } },
  { id: 'q4-ctx2k', label: 'Q4_K_M, оптимум, но окно 2048', model: 'q4', params: { ...OPT, num_ctx: 2048 } },
  { id: 'q4-ctx4k', label: 'Q4_K_M, оптимум, но окно 4096', model: 'q4', params: { ...OPT, num_ctx: 4096 } },
  { id: 'q4-np64', label: 'Q4_K_M, оптимум, но max tokens 64', model: 'q4', params: { ...OPT, num_predict: 64 } },
  { id: 'q4-opt', label: 'после: Q4_K_M, оптимальные параметры', model: 'q4', params: OPT },
  { id: 'q3-default', label: 'Q3_K_M, по умолчанию', model: 'q3', params: {} },
  { id: 'q3-opt', label: 'Q3_K_M, оптимальные параметры', model: 'q3', params: OPT },
  { id: 'q8-default', label: 'Q8_0, по умолчанию', model: 'q8', params: {} },
  { id: 'q8-opt', label: 'Q8_0, оптимальные параметры', model: 'q8', params: OPT },
  // Nothing sent: the parameters must come from the Modelfile.
  { id: 'extractor', label: 'итог: order-extractor, параметры из Modelfile', model: 'extractor', params: {} },
];

export const FIELDS = ['customer', 'phone', 'city', 'items', 'delivery_date', 'payment', 'urgent'] as const;
export type Field = (typeof FIELDS)[number];

export async function ollama(pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${OLLAMA}${pathname}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function unloadAll(): Promise<void> {
  const { models } = await ollama('/api/ps');
  for (const m of models ?? []) await ollama('/api/generate', { model: m.name, keep_alive: 0 });
}

export const sameModel = (listed: any, name: string) => [listed.name, listed.model].some((n: string) => n === name || n === `${name}:latest`);

export async function chat(model: string, email: { date: string; text: string }, params: Params): Promise<any> {
  return ollama('/api/chat', {
    model,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(email.date, email.text) },
    ],
    options: params,
  });
}

// --- Scoring ---------------------------------------------------------------------

/** The first {...} of the answer, code fences and surrounding prose ignored. */
export function parseOrder(raw: string): Record<string, any> | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

export function scoreOrder(got: Record<string, any>, want: ExpectedOrder): Record<Field, boolean> {
  const items: Record<string, number> = {};
  for (const it of Array.isArray(got.items) ? got.items : []) {
    const sku = String(it?.sku ?? '').trim().toUpperCase();
    // {"sku": "IR-050", "qty": 0} for a removed item says the same as leaving it out.
    if (Number(it?.qty) === 0) continue;
    items[sku] = (items[sku] ?? 0) + Number(it?.qty);
  }
  const wantSkus = Object.keys(want.items);
  return {
    customer: norm(got.customer).includes(norm(want.customer)),
    phone: String(got.phone ?? '').trim() === want.phone,
    // "г. Казань", "Санкт-Петербург" vs "Санкт Петербург" — the city's name, not the whole address.
    city: (() => {
      const g = norm(got.city).replace(/^г /, '');
      return g === norm(want.city) || g.startsWith(norm(want.city) + ' ');
    })(),
    items: Object.keys(items).length === wantSkus.length && wantSkus.every((s) => items[s] === want.items[s]),
    delivery_date: (got.delivery_date ?? null) === want.delivery_date || (want.delivery_date === null && got.delivery_date === 'null'),
    payment: got.payment === want.payment,
    urgent: got.urgent === want.urgent,
  };
}
