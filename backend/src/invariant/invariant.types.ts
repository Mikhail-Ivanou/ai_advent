export type InvariantCategory = 'architecture' | 'decision' | 'stack' | 'business-rule';

export const INVARIANT_CATEGORY_LABELS: Record<InvariantCategory, string> = {
  architecture: 'Архитектура',
  decision: 'Принятые решения',
  stack: 'Ограничения стека',
  'business-rule': 'Бизнес-правила',
};

export interface Invariant {
  id: string;
  category: InvariantCategory;
  /** Short label, e.g. "База данных". */
  title: string;
  /** The actual rule text, e.g. "Используем только PostgreSQL — никаких других СУБД." */
  rule: string;
  /** Inactive invariants are kept (for re-enabling later, e.g. to test "with vs without") but never injected or checked against. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InvariantInput = Pick<Invariant, 'category' | 'title' | 'rule'> & Partial<Pick<Invariant, 'active'>>;
