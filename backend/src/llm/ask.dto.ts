import { ContextConfig, InvariantConfig, McpConfig, MemoryConfig, RagConfig, TaskConfig } from './agent';
import { ReasoningMode } from './llm.client';

export class AskDto {
  prompt: string;
  format?: 'text' | 'json';
  maxOutputTokens?: number;
  stopSequence?: string;
  reasoningMode?: ReasoningMode;
  temperature?: number;
  model?: string;
  /** Which context-management strategy to use for this turn. */
  context?: ContextConfig;
  /** Which memory layers to use/update for this turn (Day 11). */
  memory?: MemoryConfig;
  /** Which personalization profile to apply to this turn, if any (Day 12). */
  profileId?: string;
  /** Whether to run the task-state transition step this turn (Day 13). */
  task?: TaskConfig;
  /** Whether to apply/check invariants this turn (Day 14). */
  invariants?: InvariantConfig;
  /** Whether to offer connected MCP servers' tools to the model this turn (Day 17). */
  mcp?: McpConfig;
  /** Whether to add chunks retrieved from the document index to the prompt (Day 21). */
  rag?: RagConfig;
}
