import 'dotenv/config';
import { callLlm } from './llm.client';

async function main() {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.error('Usage: npm run ask --workspace=backend -- "your prompt"');
    process.exit(1);
  }

  const answer = await callLlm(prompt);
  console.log(answer);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
