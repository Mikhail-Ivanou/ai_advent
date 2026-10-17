import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { callLlm, ChatMessage, LlmUsage, ToolCallLog } from '../llm/llm.client';
import { McpEndpointClient } from '../mcp/endpoint-client';
import { ProjectDocsIndex, readRepoFiles } from '../dev-assistant/project-docs';
import { SearchHit } from '../rag/rag.types';
import * as path from 'path';

// Day 33: support assistant for the Advent LLM service (llm-gateway + the
// LLM Chat iOS app). Every answer combines:
// - the user's and the ticket's data from the CRM (MCP server "crm"): plan,
//   subscription, devices with key status, the ticket thread, and the
//   gateway's technical events per device — that's what tells *this* user's
//   cause apart ("ключ отозван" vs "пробный период закончился" vs "запросы не
//   доходят до сервера");
// - RAG over the user-facing FAQ and the product docs;
// - the CRM's read tools, for anything else the model wants to look up.

const CRM_URL = process.env.SUPPORT_CRM_MCP_URL?.trim() || 'http://localhost:3002/mcp/crm';
const CRM_TOKEN = process.env.SUPPORT_CRM_MCP_TOKEN?.trim() || process.env.MCP_AUTH_TOKEN?.trim() || undefined;
const TOP_K = 5;

/** What the support RAG reads: the FAQ first, then the product's own docs. */
const SUPPORT_DOCS = [
  { path: 'docs/support/faq.md', group: 'faq' as const },
  { path: 'llm-gateway/README.md', group: 'readme' as const },
  { path: 'ios/LLMChat/README.md', group: 'readme' as const },
];

export interface SupportAskInput {
  message: string;
  /** The ticket this conversation is about (its user is taken from it). */
  ticketId?: string;
  /** Without a ticket: the user's email, name or id. */
  user?: string;
  history?: ChatMessage[];
  model?: string;
}

/** A ticket as the CRM returns it (mcp-weather/src/crm.ts). */
export interface CrmTicket {
  id: string;
  user_id: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved';
  priority: string;
  channel: string;
  created_at: string;
  messages: { from: 'user' | 'agent' | 'assistant'; at: string; text: string }[];
  internal_notes: string[];
}

export interface SupportSource {
  n: number;
  file: string;
  section: string;
  score: number;
  cited: boolean;
  text: string;
}

export interface SupportReply {
  answer: string;
  /** The model's call: hand the ticket to a human (key reissue, plan change, outage…). */
  escalate?: { needed: boolean; reason: string };
  ticketId?: string;
  userId?: string;
  /** The CRM data the answer was given with, as the model saw it. */
  context: { user?: string; ticket?: string; otherTickets?: string; events?: string; error?: string };
  sources: SupportSource[];
  toolCalls?: ToolCallLog[];
  model?: string;
  usage?: LlmUsage;
  durationMs: number;
}

const SUPPORT_INSTRUCTIONS = `Ты — ассистент службы поддержки сервиса Advent LLM (приватная языковая модель в локальной сети: сервер llm-gateway и приложение LLM Chat для iPhone). Ты отвечаешь пользователю напрямую, на «вы», по-русски, коротко и по делу.

Как отвечать:
1. Сначала определи причину именно у этого пользователя по данным CRM ниже: тариф и подписка, статус ключа на каждом устройстве (active / revoked / disabled), события шлюза по устройствам (коды ошибок, когда начались, есть ли запросы вообще), история тикета. Назови причину с опорой на конкретный факт: устройство, последние 4 символа ключа, дату, код ошибки. Если от устройства нет ни одного запроса — запросы не доходят до сервера, значит дело в подключении (адрес, сеть, VPN), а не в ключе. Сервер доступен только из той локальной сети, где он стоит: сравни, откуда пользователь подключался успешно (source_ip в событиях, заметки) и откуда пишет сейчас — из другой сети без VPN не подключиться даже с правильным адресом.
2. Затем дай конкретные шаги, что сделать пользователю. Опирайся на фрагменты FAQ и документации [n] и ссылайся на них номерами.
3. Если вопрос пользователя не совпадает с настоящей причиной (например, «авторизация», а на деле лимит запросов), мягко объясни, что происходит на самом деле.
4. Если данных недостаточно — задай один уточняющий вопрос, не выдумывай.

Заметки и внутренние заметки сотрудников используй, чтобы понять ситуацию, но не цитируй их и не пересказывай пользователю дословно.
Нельзя: раскрывать внутренние заметки сотрудников и их формулировки, полные ключи, данные других пользователей, внутреннее устройство сервера (переменные окружения, команды администратора). Нельзя обещать действия, которые делает только сотрудник (перевыпуск ключа, смена тарифа, продление подписки), — предложи передать обращение сотруднику.

Последней строкой ответа всегда напиши ровно одно из:
ПЕРЕДАТЬ СОТРУДНИКУ: нет
ПЕРЕДАТЬ СОТРУДНИКУ: да — <зачем, в нескольких словах>`;

function formatExcerpts(hits: SearchHit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.metadata.file}${h.metadata.section ? ` › ${h.metadata.section}` : ''}\n${h.text}`).join('\n\n');
}

/** Splits off the escalation line the model is told to end with. */
export function parseEscalation(text: string): { answer: string; escalate?: SupportReply['escalate'] } {
  const m = /\n?\s*ПЕРЕДАТЬ СОТРУДНИКУ:\s*(да|нет)\s*(?:[—–-]\s*(.*))?\s*$/i.exec(text);
  if (!m) return { answer: text.trim() };
  return {
    answer: text.slice(0, m.index).trim(),
    escalate: { needed: m[1].toLowerCase() === 'да', reason: (m[2] ?? '').trim() },
  };
}

@Injectable()
export class SupportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupportService.name);
  readonly crm = new McpEndpointClient(CRM_URL, 'crm', CRM_TOKEN);
  readonly docs = new ProjectDocsIndex({
    indexPath: path.join(process.cwd(), 'data', 'support', 'index.json'),
    collect: () => readRepoFiles(SUPPORT_DOCS),
  });

  onApplicationBootstrap() {
    void this.docs
      .ensure()
      .then((s) => this.logger.log(`Support docs indexed: ${s.documents.length} files, ${s.chunks} chunks`))
      .catch((error) => this.logger.warn(`Support docs indexing failed: ${(error as Error).message}`));
  }

  async status() {
    const [docs, tools] = await Promise.all([
      this.docs.ensure(),
      this.crm.listTools().then(
        (t) => ({ tools: t.map((x) => x.name) }),
        (e: Error) => ({ tools: [] as string[], crmError: e.message }),
      ),
    ]);
    return {
      crmUrl: this.crm.url,
      ...tools,
      docs: { chunks: docs.chunks, files: docs.documents.map((d) => ({ path: d.path, chunks: d.chunks })) },
    };
  }

  async tickets() {
    const r = await this.crm.call('crm_list_tickets');
    if (r.isError) throw new Error(r.text);
    return r.structured?.tickets ?? [];
  }

  async ticket(id: string) {
    const t = await this.crm.call('crm_get_ticket', { ticket_id: id });
    if (t.isError) throw new Error(t.text);
    const ticket = t.structured?.ticket as unknown as CrmTicket;
    const u = await this.crm.call('crm_get_user', { user_id: ticket.user_id });
    return { ticket, user: u.structured?.user, plan: u.structured?.plan };
  }

  async users() {
    const r = await this.crm.call('crm_list_users');
    if (r.isError) throw new Error(r.text);
    return r.structured?.users ?? [];
  }

  /** A new request from a user — for the demo, to simulate incoming tickets. */
  async createTicket(input: { userId: string; subject?: string; text: string; channel?: string; priority?: string }) {
    const text = input.text.trim();
    // Without a subject, the first sentence of the message (as mail clients do).
    const subject = input.subject?.trim() || text.split(/(?<=[.!?])\s|\n/)[0].slice(0, 80);
    const r = await this.crm.call('crm_create_ticket', {
      user_id: input.userId,
      subject,
      text,
      channel: input.channel ?? 'app',
      priority: input.priority ?? 'normal',
    });
    if (r.isError) throw new Error(r.text);
    return r.structured?.ticket as unknown as CrmTicket;
  }

  /** Writes the (possibly edited) answer into the ticket as a reply to the user. */
  async reply(ticketId: string, text: string, status?: 'open' | 'pending' | 'resolved') {
    const r = await this.crm.call('crm_add_ticket_reply', { ticket_id: ticketId, text, kind: 'reply', ...(status ? { status } : {}) });
    if (r.isError) throw new Error(r.text);
    return r.structured ?? { message: r.text };
  }

  async ask(input: SupportAskInput): Promise<SupportReply> {
    const started = Date.now();
    const context = await this.loadContext(input);

    // The search query carries what the user asked plus what the data says:
    // "почему не работает авторизация" alone matches every auth paragraph,
    // "… revoked invalid_api_key" finds the one about a reissued key.
    const codes = [...new Set([...(context.events ?? '').matchAll(/\b(\d{3}) ([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`))];
    const keyStates = [...new Set([...(context.user ?? '').matchAll(/— (revoked|disabled|active)/g)].map((m) => m[1]))];
    const query = [input.message, context.subject, codes.join(' '), keyStates.join(' ')].filter(Boolean).join('\n');
    const hits = await this.docs.search(query, TOP_K);

    // Read tools only, and not the full user list: the model works on one user.
    const toolset = await this.crm.toolset((t) => t.annotations?.readOnlyHint === true && t.name !== 'crm_list_users').catch(() => undefined);
    const crmBlock = [
      context.error ? `CRM недоступна: ${context.error}` : '',
      context.user ? `## Пользователь (CRM)\n${context.user}` : '## Пользователь не определён',
      context.ticket ? `## Текущий тикет\n${context.ticket}` : '',
      context.otherTickets ? `## Другие тикеты пользователя\n${context.otherTickets}` : '',
      context.events ? `## События шлюза по устройствам пользователя\n${context.events}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const systemPrompt = `${SUPPORT_INSTRUCTIONS}\n\nСегодня ${new Date().toISOString().slice(0, 10)}.\n\n${crmBlock}\n\n## FAQ и документация (RAG)\n${formatExcerpts(hits)}`;

    const result = await callLlm(
      input.message,
      { model: input.model, temperature: 0.2, history: (input.history ?? []).slice(-8), systemPrompt, tools: toolset },
      'support:answer',
    );
    const { answer, escalate } = parseEscalation(result.content);
    const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return {
      answer,
      escalate,
      ticketId: context.ticketId,
      userId: context.userId,
      context: { user: context.user, ticket: context.ticket, otherTickets: context.otherTickets, events: context.events, error: context.error },
      sources: hits.map((h, i) => ({
        n: i + 1,
        file: h.metadata.file,
        section: h.metadata.section,
        score: Math.round(h.score * 1000) / 1000,
        cited: cited.has(i + 1),
        text: h.text,
      })),
      toolCalls: result.toolCalls,
      model: result.model,
      usage: result.usage,
      durationMs: Date.now() - started,
    };
  }

  /** The ticket and its user, the user's other tickets and their gateway events — read before the model is asked anything. */
  private async loadContext(input: SupportAskInput) {
    const ctx: {
      ticketId?: string;
      userId?: string;
      subject?: string;
      user?: string;
      ticket?: string;
      otherTickets?: string;
      events?: string;
      error?: string;
    } = {};
    try {
      if (input.ticketId) {
        const t = await this.crm.call('crm_get_ticket', { ticket_id: input.ticketId });
        if (t.isError) throw new Error(t.text);
        const ticket = t.structured?.ticket as unknown as CrmTicket;
        ctx.ticketId = ticket.id;
        ctx.userId = ticket.user_id;
        ctx.subject = ticket.subject;
        ctx.ticket = t.text;
      } else if (input.user?.trim()) {
        const f = await this.crm.call('crm_find_user', { query: input.user.trim() });
        const users = (f.structured?.users as { id: string }[] | undefined) ?? [];
        if (users.length === 1) ctx.userId = users[0].id;
        else if (users.length > 1) ctx.user = `Найдено несколько пользователей, уточните:\n${f.text}`;
      }
      if (ctx.userId) {
        const [user, tickets, events] = await Promise.all([
          this.crm.call('crm_get_user', { user_id: ctx.userId }),
          this.crm.call('crm_list_tickets', { user_id: ctx.userId }),
          this.crm.call('crm_get_gateway_events', { user_id: ctx.userId, limit: 30 }),
        ]);
        ctx.user = user.text;
        ctx.otherTickets = tickets.text
          .split('\n')
          .filter((l) => !ctx.ticketId || !l.startsWith(ctx.ticketId))
          .join('\n');
        ctx.events = events.text;
      }
    } catch (error) {
      ctx.error = (error as Error).message;
    }
    return ctx;
  }
}
