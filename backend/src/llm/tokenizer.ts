import { countTokens as countTokensBpe } from 'gpt-tokenizer';
import { ChatMessage } from './llm.client';

/**
 * Local, model-agnostic token count (cl100k_base BPE) — an estimate, since
 * the provider's own tokenizer may differ slightly, but close enough to
 * track request/history/response size without depending on the API's
 * aggregate `usage` field.
 */
export function countTokens(text: string): number {
  return text ? countTokensBpe(text) : 0;
}

export function countHistoryTokens(history: ChatMessage[]): number {
  return history.reduce((sum, message) => sum + countTokens(message.content), 0);
}
