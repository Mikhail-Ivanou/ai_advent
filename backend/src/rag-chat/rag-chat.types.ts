import { Grounding } from '../rag/grounding';
import { PipelineConfig } from '../rag/rag-pipeline';

// Day 25: a mini chat over the document index — history, RAG on every
// question, sources on every answer, and a task memory of the dialog.

/** What the dialog is about, kept across turns and updated after each user message. */
export interface TaskMemory {
  /** The goal of the dialog in one sentence; changes only when the user changes it. */
  goal: string;
  /** What the user has already clarified (who "он" is, which part of the book, …). */
  clarified: string[];
  /** Constraints on answers: format, length, scope, sources. */
  constraints: string[];
  /** Fixed terms: "term — meaning". */
  terms: string[];
}

export const EMPTY_MEMORY: TaskMemory = {
  goal: '',
  clarified: [],
  constraints: [],
  terms: [],
};

export interface RagChatSource {
  n: number;
  chunk_id: string;
  source: string;
  title: string;
  section: string;
  file: string;
}

export interface RagChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Assistant only: how the answer was found and checked. */
  meta?: {
    /**
     * "search" — a question about the documents, answered from retrieved chunks;
     * "dialog" — about the dialog itself (goal, a summary of what was found):
     * answered from the memory and history, with the sources gathered so far;
     * "note" — no question, only a clarification / constraint / term: the
     * memory is updated and the change is confirmed, nothing is searched.
     */
    kind: 'search' | 'dialog' | 'note';
    /** The standalone search query the message was turned into, using history and memory. */
    searchQuery: string;
    grounding: Grounding;
    candidates: number;
    hits: {
      chunk_id: string;
      score: number;
      rerankScore?: number;
      section: string;
      text: string;
    }[];
    model: string;
    durationMs: number;
    tokens?: number;
    /** Task memory as it was when this answer was given. */
    memory: TaskMemory;
  };
}

export interface RagChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: RagChatMessage[];
  memory: TaskMemory;
  settings: Partial<PipelineConfig>;
}

export const DEFAULT_CHAT_SETTINGS: Partial<PipelineConfig> = {
  strategy: 'structural',
  search: 'hybrid',
  rerank: 'cross-encoder',
  candidates: 20,
  k: 5,
  minScore: 0.2,
};
