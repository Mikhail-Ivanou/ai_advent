import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { LongTermMemoryProposal, MEMORY_CATEGORY_LABELS, MemoryCategory, MemoryEntry } from './memory.types';

const STORE_PATH = path.join(process.cwd(), 'data', 'memory.json');

/**
 * Long-term memory: profile facts, decisions and knowledge that should survive
 * across chats — unlike short-term (a chat's own history) and working memory
 * (per-chat, task-scoped, see Agent.workingMemory), this store is global and
 * lives independently of any one Agent, so deleting a chat never touches it.
 */
@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);
  private entries: MemoryEntry[] = [];

  async onModuleInit() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      this.entries = JSON.parse(raw);
      this.logger.log(`Restored ${this.entries.length} long-term memory entr(y/ies) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read memory store: ${(error as Error).message}`);
      }
    }
  }

  list(): MemoryEntry[] {
    return [...this.entries].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).reverse();
  }

  async create(category: MemoryCategory, key: string, value: string, source: MemoryEntry['source'] = 'manual'): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = { id: randomUUID(), category, key: key.trim(), value: value.trim(), source, createdAt: now, updatedAt: now };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  async update(id: string, patch: Partial<Pick<MemoryEntry, 'category' | 'key' | 'value'>>): Promise<MemoryEntry> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new NotFoundException(`Unknown memory entry: ${id}`);
    if (patch.category) entry.category = patch.category;
    if (patch.key !== undefined) entry.key = patch.key.trim();
    if (patch.value !== undefined) entry.value = patch.value.trim();
    entry.updatedAt = new Date().toISOString();
    await this.persist();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) throw new NotFoundException(`Unknown memory entry: ${id}`);
    await this.persist();
  }

  /**
   * Applies the memory-routing step's proposals: matches each proposal against
   * an existing entry by category+key (case-insensitive), updating its value if
   * found, else creating a new agent-sourced entry. Returns the entries that
   * were actually created or changed, so callers can show "added this turn".
   */
  async upsertMany(proposals: LongTermMemoryProposal[], source: MemoryEntry['source'] = 'agent'): Promise<MemoryEntry[]> {
    const changed: MemoryEntry[] = [];
    const now = new Date().toISOString();
    for (const proposal of proposals) {
      const key = proposal.key.trim();
      const value = proposal.value.trim();
      if (!key || !value) continue;
      const existing = this.entries.find(
        (e) => e.category === proposal.category && e.key.toLowerCase() === key.toLowerCase(),
      );
      if (existing) {
        if (existing.value === value) continue; // nothing actually changed
        existing.value = value;
        existing.updatedAt = now;
        changed.push(existing);
      } else {
        const entry: MemoryEntry = { id: randomUUID(), category: proposal.category, key, value, source, createdAt: now, updatedAt: now };
        this.entries.push(entry);
        changed.push(entry);
      }
    }
    if (changed.length > 0) await this.persist();
    return changed;
  }

  /** Formats all entries grouped by category, for injection into the LLM prompt. Undefined when empty, so callers can skip the system message entirely. */
  formatForPrompt(): string | undefined {
    if (this.entries.length === 0) return undefined;
    const byCategory = new Map<MemoryCategory, MemoryEntry[]>();
    for (const entry of this.entries) {
      const bucket = byCategory.get(entry.category) ?? [];
      bucket.push(entry);
      byCategory.set(entry.category, bucket);
    }
    return (Object.keys(MEMORY_CATEGORY_LABELS) as MemoryCategory[])
      .filter((category) => byCategory.has(category))
      .map((category) => {
        const lines = byCategory.get(category)!.map((e) => `- ${e.key}: ${e.value}`);
        return `${MEMORY_CATEGORY_LABELS[category]}:\n${lines.join('\n')}`;
      })
      .join('\n\n');
  }

  // Same rationale as AgentsService.persist(): serialize writes so two
  // near-simultaneous updates (e.g. two chats' memory-routing calls
  // finishing at once) can't clobber each other.
  private writeQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const snapshot = [...this.entries];
    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    };
    const current = this.writeQueue.then(writeSnapshot, writeSnapshot);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
