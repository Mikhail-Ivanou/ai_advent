import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { UserProfile, UserProfileInput } from './profile.types';

const STORE_PATH = path.join(process.cwd(), 'data', 'profiles.json');

// Shipped so there's something to compare from the very first run — Day 12
// asks specifically for "responses under different profiles", which needs at
// least two profiles to exist before anyone's written one.
function defaultProfiles(): UserProfile[] {
  const now = new Date().toISOString();
  return [
    {
      id: randomUUID(),
      name: 'Кратко и по делу',
      style: 'Формально, по делу, без вступлений и лишних слов.',
      format: 'Короткие абзацы или списки. Без воды, без повторения вопроса.',
      constraints: 'Не больше 5–6 предложений, если явно не попросили подробнее.',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      name: 'Подробно и дружелюбно',
      style: 'Неформально, дружелюбно, на «ты».',
      format: 'Подробные объяснения с примерами и пояснением терминов.',
      constraints: 'Объяснять как для новичка — не использовать термин без короткой расшифровки.',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * User profiles (Day 12): personalization on top of the memory model. Unlike
 * long-term memory (facts the agent picked up on its own), a profile is
 * always author-defined — created/edited explicitly, never auto-extracted —
 * and is attached to every request for whichever chat has it selected,
 * regardless of the memory-layer toggles.
 */
@Injectable()
export class ProfileService implements OnModuleInit {
  private readonly logger = new Logger(ProfileService.name);
  private profiles: UserProfile[] = [];

  async onModuleInit() {
    try {
      const raw = await fs.readFile(STORE_PATH, 'utf-8');
      this.profiles = JSON.parse(raw);
      this.logger.log(`Restored ${this.profiles.length} profile(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read profile store: ${(error as Error).message}`);
        return;
      }
      this.profiles = defaultProfiles();
      await this.persist();
    }
  }

  list(): UserProfile[] {
    return [...this.profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): UserProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  async create(input: UserProfileInput): Promise<UserProfile> {
    const now = new Date().toISOString();
    const profile: UserProfile = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.profiles.push(profile);
    await this.persist();
    return profile;
  }

  async update(id: string, patch: Partial<UserProfileInput>): Promise<UserProfile> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new NotFoundException(`Unknown profile: ${id}`);
    Object.assign(profile, patch);
    profile.updatedAt = new Date().toISOString();
    await this.persist();
    return profile;
  }

  async remove(id: string): Promise<void> {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.profiles.length === before) throw new NotFoundException(`Unknown profile: ${id}`);
    await this.persist();
  }

  /** Formats one profile for injection into the system prompt. Undefined for an unknown/unset id, so callers can skip the message entirely. */
  formatForPrompt(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const profile = this.get(id);
    if (!profile) return undefined;

    const lines: string[] = [];
    if (profile.style.trim()) lines.push(`Стиль общения: ${profile.style.trim()}`);
    if (profile.format.trim()) lines.push(`Формат ответа: ${profile.format.trim()}`);
    if (profile.constraints.trim()) lines.push(`Ограничения: ${profile.constraints.trim()}`);
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const snapshot = [...this.profiles];
    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      await fs.writeFile(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    };
    const current = this.writeQueue.then(writeSnapshot, writeSnapshot);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
