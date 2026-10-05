import 'dotenv/config';
import { callLlm } from './llm.client';

async function main() {
  const args = process.argv.slice(2);
  // --model ollama/qwen2.5:7b runs the prompt on the local LLM (Day 26).
  const modelIndex = args.indexOf('--model');
  const model = modelIndex !== -1 ? args.splice(modelIndex, 2)[1] : undefined;
  const prompt = args.join(' ');
  if (!prompt) {
    console.error('Usage: npm run ask --workspace=backend -- [--model ollama/qwen2.5:7b] "your prompt"');
    process.exit(1);
  }

  const started = Date.now();
  const result = await callLlm(prompt, { model });
  console.log(result.content);
  const tokens = result.usage ? ` · ${result.usage.totalTokens} tokens` : '';
  console.error(`\n[${result.model} · ${((Date.now() - started) / 1000).toFixed(1)} s${tokens}]`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
