import 'dotenv/config';
import { callLlmWithReasoning } from './llm.client';

/**
 * Day 3: same task solved through the API four different ways —
 * direct answer, step-by-step instruction, self-authored prompt, and an expert panel.
 */
const TASK = `На столе стоят три коробки. На каждой есть этикетка: «Яблоки», «Апельсины», «Яблоки и апельсины».
Известно, что все три этикетки перепутаны — ни одна не соответствует настоящему содержимому коробки.
Разрешается достать всего один фрукт из одной коробки (не глядя внутрь).
Как, взяв один фрукт из правильно выбранной коробки, определить истинное содержимое всех трёх коробок?`;

async function main() {
  console.log('=== Задача ===\n' + TASK + '\n');

  console.log('=== 1. Прямой ответ (без инструкций) ===');
  console.log(await callLlmWithReasoning(TASK, 'direct'));

  console.log('\n=== 2. С инструкцией «решай пошагово» ===');
  console.log(await callLlmWithReasoning(TASK, 'step-by-step'));

  console.log('\n=== 3. Сначала промпт, потом решение по нему ===');
  console.log(await callLlmWithReasoning(TASK, 'self-prompt'));

  console.log('\n=== 4. Группа экспертов (аналитик, инженер, критик) ===');
  console.log(await callLlmWithReasoning(TASK, 'expert-panel'));
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
