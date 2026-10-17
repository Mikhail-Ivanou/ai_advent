import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Day 33: a small CRM for the support assistant — users of the Advent LLM
// service (plan, subscription, devices and their keys), their tickets and the
// gateway's technical events per device (status and error code, never message
// text). The seed is versioned (crm/seed.json); changes made through the tools
// (replies, statuses) go to data/crm.json, so a demo can be reset by deleting
// that file.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(HERE, '..', 'crm', 'seed.json');
const DATA_PATH = process.env.CRM_DATA_PATH?.trim() || path.join(HERE, '..', 'data', 'crm.json');

type TicketStatus = 'open' | 'pending' | 'resolved';
interface Plan { name: string; devices: number; rate_limit_per_minute: number; term: string }
interface Device {
  client: string;
  device: string;
  key_last4: string;
  key_status: 'active' | 'revoked' | 'disabled';
  key_issued_at: string;
  key_revoked_at?: string;
  disabled_reason?: string;
  last_ok_at?: string;
}
interface User {
  id: string;
  name: string;
  email: string;
  company: string | null;
  plan: string;
  subscription: Record<string, string>;
  created_at: string;
  devices: Device[];
  notes: string;
}
interface Message { from: 'user' | 'agent' | 'assistant'; at: string; text: string }
interface Ticket {
  id: string;
  user_id: string;
  subject: string;
  status: TicketStatus;
  priority: string;
  channel: string;
  created_at: string;
  messages: Message[];
  internal_notes: string[];
}
interface GatewayEvent { at: string; client: string; key_last4: string; status: number; code: string; detail?: string; count?: number; source_ip?: string }
interface CrmData { plans: Record<string, Plan>; users: User[]; tickets: Ticket[]; events: GatewayEvent[] }

class CrmError extends Error {}

/** The CRM's data, loaded once per process; every change is written through to DATA_PATH. */
export class CrmStore {
  private data?: CrmData;
  private writing: Promise<void> = Promise.resolve();

  async load(): Promise<CrmData> {
    if (this.data) return this.data;
    const raw = await fs.readFile(DATA_PATH, 'utf8').catch(() => fs.readFile(SEED_PATH, 'utf8'));
    this.data = JSON.parse(raw) as CrmData;
    return this.data;
  }

  private save(): Promise<void> {
    // Serialized: two quick replies must not interleave their writes.
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
      await fs.writeFile(DATA_PATH, JSON.stringify(this.data, null, 2));
    });
    return this.writing;
  }

  async user(id: string): Promise<User> {
    const user = (await this.load()).users.find((u) => u.id.toLowerCase() === id.trim().toLowerCase());
    if (!user) throw new CrmError(`Пользователь ${id} не найден`);
    return user;
  }

  async ticket(id: string): Promise<Ticket> {
    const ticket = (await this.load()).tickets.find((t) => t.id.toLowerCase() === id.trim().toLowerCase());
    if (!ticket) throw new CrmError(`Тикет ${id} не найден`);
    return ticket;
  }

  /** A new ticket from a user (Day 33 demo: simulating incoming requests). Ids continue the T-NNNN sequence. */
  async createTicket(input: { user_id: string; subject: string; text: string; channel: string; priority: string }): Promise<Ticket> {
    const data = await this.load();
    await this.user(input.user_id);
    const next = Math.max(1000, ...data.tickets.map((t) => Number(t.id.replace(/\D/g, '')) || 0)) + 1;
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id: `T-${next}`,
      user_id: input.user_id,
      subject: input.subject,
      status: 'open',
      priority: input.priority,
      channel: input.channel,
      created_at: now,
      messages: [{ from: 'user', at: now, text: input.text }],
      internal_notes: [],
    };
    data.tickets.push(ticket);
    await this.save();
    return ticket;
  }

  async addMessage(ticketId: string, text: string, kind: 'reply' | 'internal_note', status?: TicketStatus): Promise<Ticket> {
    const ticket = await this.ticket(ticketId);
    if (kind === 'internal_note') ticket.internal_notes.push(text);
    else ticket.messages.push({ from: 'assistant', at: new Date().toISOString(), text });
    if (status) ticket.status = status;
    await this.save();
    return ticket;
  }

}

function result(text: string, structuredContent?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(structuredContent ? { structuredContent } : {}) };
}

function toolError(error: unknown) {
  if (error instanceof CrmError) return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  throw error;
}

function describeUser(u: User, plans: Record<string, Plan>): string {
  const plan = plans[u.plan];
  const sub = Object.entries(u.subscription).map(([k, v]) => `${k}: ${v}`).join(', ');
  const devices = u.devices
    .map((d) => {
      const key = `ключ …${d.key_last4} — ${d.key_status}${d.key_revoked_at ? ` с ${d.key_revoked_at}` : ''}${d.disabled_reason ? ` (${d.disabled_reason})` : ''}, выдан ${d.key_issued_at}`;
      return `  • ${d.client} (${d.device}): ${key}; последний успешный запрос: ${d.last_ok_at ?? 'нет'}`;
    })
    .join('\n');
  return [
    `${u.id} — ${u.name} <${u.email}>${u.company ? `, ${u.company}` : ''}`,
    `Тариф: ${plan?.name ?? u.plan} (устройств до ${plan?.devices}, ${plan?.rate_limit_per_minute} запросов/мин, ${plan?.term}); подписка: ${sub}`,
    `Клиент с ${u.created_at}. Устройства:`,
    devices || '  (нет)',
    u.notes ? `Заметка для сотрудников: ${u.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function describeTicket(t: Ticket, withNotes: boolean): string {
  const msgs = t.messages.map((m) => `  [${m.at}] ${m.from === 'user' ? 'Пользователь' : m.from === 'agent' ? 'Сотрудник' : 'Ассистент'}: ${m.text}`).join('\n');
  return [
    `${t.id} «${t.subject}» — ${t.status}, приоритет ${t.priority}, канал ${t.channel}, создан ${t.created_at}, пользователь ${t.user_id}`,
    'Переписка:',
    msgs,
    withNotes && t.internal_notes.length ? `Внутренние заметки (не показывать пользователю): ${t.internal_notes.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createCrmServer(store: CrmStore): McpServer {
  const server = new McpServer({ name: 'advent-crm', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'crm_find_user',
    {
      title: 'Найти пользователя',
      description: 'Поиск пользователя сервиса Advent LLM по email, имени, компании или id (U-001). Возвращает id, имя, email, тариф.',
      inputSchema: { query: z.string().min(2) },
      annotations: readOnly,
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const data = await store.load();
      const found = data.users.filter((u) => [u.id, u.name, u.email, u.company ?? ''].some((v) => v.toLowerCase().includes(q)));
      if (!found.length) return result(`Пользователи по запросу «${query}» не найдены.`);
      return result(
        found.map((u) => `${u.id} — ${u.name} <${u.email}>, тариф ${data.plans[u.plan]?.name ?? u.plan}, подписка ${u.subscription.status}`).join('\n'),
        { users: found.map((u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan })) },
      );
    },
  );

  server.registerTool(
    'crm_get_user',
    {
      title: 'Карточка пользователя',
      description:
        'Карточка пользователя: тариф и его лимиты, состояние подписки, устройства с последними 4 символами ключа и статусом ключа (active / revoked / disabled), время последнего успешного запроса, заметка для сотрудников.',
      inputSchema: { user_id: z.string().describe('Например "U-001"') },
      annotations: readOnly,
    },
    async ({ user_id }) => {
      try {
        const data = await store.load();
        const user = await store.user(user_id);
        return result(describeUser(user, data.plans), { user, plan: data.plans[user.plan] });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'crm_list_tickets',
    {
      title: 'Тикеты',
      description: 'Список тикетов поддержки, по пользователю и/или статусу (open, pending, resolved). Без параметров — все тикеты.',
      inputSchema: {
        user_id: z.string().optional(),
        status: z.enum(['open', 'pending', 'resolved']).optional(),
      },
      annotations: readOnly,
    },
    async ({ user_id, status }) => {
      const data = await store.load();
      const tickets = data.tickets.filter((t) => (!user_id || t.user_id === user_id) && (!status || t.status === status));
      const lines = tickets.map((t) => {
        const user = data.users.find((u) => u.id === t.user_id);
        return `${t.id} [${t.status}, ${t.priority}] «${t.subject}» — ${user?.name ?? t.user_id}, ${t.created_at}`;
      });
      return result(lines.length ? lines.join('\n') : 'Тикетов нет.', {
        tickets: tickets.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
          channel: t.channel,
          created_at: t.created_at,
          user_id: t.user_id,
          user_name: data.users.find((u) => u.id === t.user_id)?.name,
          messages: t.messages.length,
        })),
      });
    },
  );

  server.registerTool(
    'crm_get_ticket',
    {
      title: 'Тикет',
      description: 'Тикет поддержки целиком: тема, статус, приоритет, вся переписка и внутренние заметки сотрудников (их нельзя пересказывать пользователю).',
      inputSchema: { ticket_id: z.string().describe('Например "T-1041"') },
      annotations: readOnly,
    },
    async ({ ticket_id }) => {
      try {
        const ticket = await store.ticket(ticket_id);
        return result(describeTicket(ticket, true), { ticket });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'crm_get_gateway_events',
    {
      title: 'События шлюза по пользователю',
      description:
        'Технические события сервиса по устройствам пользователя: время, устройство (client), последние 4 символа ключа, HTTP-статус и код ошибки (invalid_api_key, rate_limit_exceeded, context_length_exceeded…), сколько раз подряд. Текстов сообщений здесь нет. Если событий от устройства нет вовсе — запросы до сервера не доходят (проблема подключения, а не ключа).',
      inputSchema: {
        user_id: z.string(),
        client: z.string().optional().describe('Только одно устройство, например "anna-iphone"'),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: readOnly,
    },
    async ({ user_id, client, limit }) => {
      try {
        const data = await store.load();
        const user = await store.user(user_id);
        const clients = new Set(user.devices.map((d) => d.client));
        const events = data.events
          .filter((e) => clients.has(e.client) && (!client || e.client === client))
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(-limit);
        const lines = events.map(
          (e) =>
            `[${e.at}] ${e.client} …${e.key_last4}: ${e.status} ${e.code}${e.detail ? ` (${e.detail})` : ''}${e.count && e.count > 1 ? ` ×${e.count}` : ''}${e.source_ip ? ` с ${e.source_ip}` : ''}`,
        );
        // A device the gateway hasn't heard from for a week never reaches it:
        // a connection problem, not a key one. "Now" is the newest event, so
        // the seeded history reads the same whenever the demo runs.
        const newest = data.events.reduce((m, e) => (e.at > m ? e.at : m), '');
        const since = new Date(new Date(newest).getTime() - 7 * 86_400_000).toISOString();
        const silent = [...clients].filter((c) => !data.events.some((e) => e.client === c && new Date(e.at).toISOString() >= since));
        const tail = silent.length ? `\nНет ни одного запроса за 7 дней до ${newest.slice(0, 10)} от: ${silent.join(', ')}` : '';
        return result((lines.length ? lines.join('\n') : 'Событий нет.') + tail, { events });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'crm_list_users',
    {
      title: 'Все пользователи',
      description: 'Список всех пользователей: id, имя, email, тариф, статус подписки.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const data = await store.load();
      const users = data.users.map((u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, plan_name: data.plans[u.plan]?.name, subscription: u.subscription.status }));
      return result(users.map((u) => `${u.id} — ${u.name} <${u.email}>, ${u.plan_name}, подписка ${u.subscription}`).join('\n'), { users });
    },
  );

  server.registerTool(
    'crm_create_ticket',
    {
      title: 'Новое обращение',
      description: 'Создаёт тикет от имени пользователя: тема и первое сообщение. Статус open.',
      inputSchema: {
        user_id: z.string(),
        subject: z.string().min(1).max(200),
        text: z.string().min(1).max(4000),
        channel: z.enum(['app', 'email', 'chat']).default('app'),
        priority: z.enum(['normal', 'high']).default('normal'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const ticket = await store.createTicket(input);
        return result(`Создан ${ticket.id} «${ticket.subject}» от ${ticket.user_id}.`, { ticket });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'crm_add_ticket_reply',
    {
      title: 'Ответить в тикет',
      description:
        'Записывает в тикет ответ пользователю (kind "reply") или внутреннюю заметку для сотрудников (kind "internal_note"); можно сразу сменить статус (pending — ждём пользователя, resolved — решено).',
      inputSchema: {
        ticket_id: z.string(),
        text: z.string().min(1).max(4000),
        kind: z.enum(['reply', 'internal_note']).default('reply'),
        status: z.enum(['open', 'pending', 'resolved']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ ticket_id, text, kind, status }) => {
      try {
        const ticket = await store.addMessage(ticket_id, text, kind, status);
        return result(`Записано в ${ticket.id} (${kind === 'reply' ? 'ответ пользователю' : 'внутренняя заметка'}); статус ${ticket.status}.`, {
          ticket_id: ticket.id,
          status: ticket.status,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
