import { CompressionSettings } from './agent';
import { ReasoningMode } from './llm.client';

export class AskDto {
  prompt: string;
  format?: 'text' | 'json';
  maxOutputTokens?: number;
  stopSequence?: string;
  reasoningMode?: ReasoningMode;
  temperature?: number;
  model?: string;
  /** History compression: keep the last N messages verbatim, summarize the rest. */
  compression?: CompressionSettings;
}
