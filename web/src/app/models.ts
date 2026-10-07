/** Models offered in the model selectors (chat, RAG, RAG chat). The first is the backend's LLM_MODEL default. */
export const MODELS = [
  { value: 'deepseek-v4-flash', label: 'Слабая (deepseek-v4-flash)' },
  { value: 'deepseek-chat-v3', label: 'Средняя (deepseek-chat-v3)' },
  { value: 'kimi-k2.5', label: 'Средняя (kimi-k2.5)' },
  { value: 'deepseek-v4-pro', label: 'Сильная (deepseek-v4-pro)' },
  { value: 'gpt-3.5-turbo-instruct', label: 'Малое окно (gpt-3.5-turbo-instruct, 4k)' },
  { value: 'deepseek-r1-distill-llama-70b', label: 'Малое окно, ближе к DeepSeek (deepseek-r1-distill-llama-70b, 8k)' },
  { value: 'qwen-2.5-72b-instruct', label: 'Малое окно, быстрее (qwen-2.5-72b-instruct, 32k)' },
  { value: 'ollama/qwen2.5:7b', label: 'Локальная (Ollama, qwen2.5:7b)' },
  { value: 'ollama/gemma3:12b', label: 'Локальная (Ollama, gemma3:12b)' },
] as const;
