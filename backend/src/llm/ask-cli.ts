import 'dotenv/config';
import { callLlm } from './llm.client';

async function main() {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.error('Usage: npm run ask --workspace=backend -- "your prompt"');
    process.exit(1);
  }

  const result = await callLlm(prompt);
  console.log(result.content);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
