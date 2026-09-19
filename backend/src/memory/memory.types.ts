export type MemoryCategory = 'profile' | 'decision' | 'knowledge';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  /** "manual" — added/edited by a person through the memory panel. "agent" — proposed by the memory-routing LLM call. */
  source: 'manual' | 'agent';
  createdAt: string;
  updatedAt: string;
}

/** What the agent's memory-routing step proposes saving to long-term memory; not yet an id'd, timestamped entry. */
export interface LongTermMemoryProposal {
  category: MemoryCategory;
  key: string;
  value: string;
}

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  profile: 'Профиль',
  decision: 'Решения',
  knowledge: 'Знания',
};
