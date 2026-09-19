import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { INVARIANT_CATEGORY_LABELS, Invariant, InvariantCategory, InvariantInput } from './invariant.types';

const STORE_PATH = path.join(process.cwd(), 'data', 'invariants.json');

// Shipped so there's an immediate, concrete conflict to test — "add MongoDB",
// "write me a login form", "just store the card number" should all trigger a
// refusal out of the box, without anyone having to write a rule first.
function defaultInvariants(): Invariant[] {
  const now = new Date().toISOString();
  return [
    {
      id: randomUUID(),
      category: 'stack',
      title: 'База данных',
      rule: 'Используем только PostgreSQL. Никаких MongoDB, MySQL, SQLite или других СУБД, даже "временно" или "для прототипа".',
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      category: 'architecture',
      title: 'Аутентификация',
      rule: 'Аутентификация пользователей — только через существующий SSO-сервис компании. Никаких самописных систем логина/пароля и никаких сторонних auth-провайдеров в обход SSO.',
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      category: 'business-rule',
      title: 'Платёжные данные',
      rule: 'Нельзя хранить номера карт, CVC или другие платёжные реквизиты пользователей в собственной базе данных ни в каком виде — только токенизация через платёжного провайдера.',
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Invariants (Day 14): hard constraints on the solution space — architecture,
 * accepted technical decisions, stack limits, business rules — kept
 * completely separate from any chat's dialog (global, like profiles), so
 * they can't be "argued away" by a long enough conversation and survive a
 * chat being deleted.
 */
@Injectable()
export class InvariantService implements OnModuleInit {
  private readonly logger = new Logger(InvariantService.name);
  private invariants: Invariant[] = [];

  async onModuleInit() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      this.invariants = JSON.parse(raw);
      this.logger.log(`Restored ${this.invariants.length} invariant(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read invariant store: ${(error as Error).message}`);
        return;
      }
      this.invariants = defaultInvariants();
      await this.persist();
    }
  }

  list(): Invariant[] {
    return [...this.invariants].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listActive(): Invariant[] {
    return this.list().filter((i) => i.active);
  }

  async create(input: InvariantInput): Promise<Invariant> {
    const now = new Date().toISOString();
    const invariant: Invariant = {
      id: randomUUID(),
      category: input.category,
      title: input.title,
      rule: input.rule,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.invariants.push(invariant);
    await this.persist();
    return invariant;
  }

  async update(id: string, patch: Partial<InvariantInput>): Promise<Invariant> {
    const invariant = this.invariants.find((i) => i.id === id);
    if (!invariant) throw new NotFoundException(`Unknown invariant: ${id}`);
    Object.assign(invariant, patch);
    invariant.updatedAt = new Date().toISOString();
    await this.persist();
    return invariant;
  }

  async remove(id: string): Promise<void> {
    const before = this.invariants.length;
    this.invariants = this.invariants.filter((i) => i.id !== id);
    if (this.invariants.length === before) throw new NotFoundException(`Unknown invariant: ${id}`);
    await this.persist();
  }

  /** Formats active invariants grouped by category, for injection into the system prompt. Undefined when there are none, so callers can skip the message entirely. */
  formatForPrompt(): string | undefined {
    const active = this.listActive();
    if (active.length === 0) return undefined;
    const byCategory = new Map<InvariantCategory, Invariant[]>();
    for (const inv of active) {
      const bucket = byCategory.get(inv.category) ?? [];
      bucket.push(inv);
      byCategory.set(inv.category, bucket);
    }
    return (Object.keys(INVARIANT_CATEGORY_LABELS) as InvariantCategory[])
      .filter((category) => byCategory.has(category))
      .map((category) => {
        const lines = byCategory.get(category)!.map((i) => `- [${i.title}] ${i.rule}`);
        return `${INVARIANT_CATEGORY_LABELS[category]}:\n${lines.join('\n')}`;
      })
      .join('\n\n');
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const snapshot = [...this.invariants];
    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    };
    const current = this.writeQueue.then(writeSnapshot, writeSnapshot);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
