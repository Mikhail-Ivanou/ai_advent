import { FindingCategory, ReviewFinding, ReviewResult } from './reviewer';

// Day 32: the review as Markdown — the PR comment, the job summary and the
// CLI output. The hidden marker lets the GitHub Action update its previous
// comment instead of adding a new one on every push.

export const REVIEW_MARKER = '<!-- ai-code-review -->';

const SECTIONS: { category: FindingCategory; title: string }[] = [
  { category: 'bug', title: '🐞 Потенциальные баги' },
  { category: 'architecture', title: '🏛 Архитектурные проблемы' },
  { category: 'recommendation', title: '💡 Рекомендации' },
];

const SEVERITY: Record<ReviewFinding['severity'], string> = { high: '🔴 высокая', medium: '🟠 средняя', low: '🟡 низкая' };

export interface RenderOptions {
  /** e.g. https://github.com/owner/repo — files become links at the head commit. */
  repoUrl?: string;
  /** Commit the links point to. */
  sha?: string;
}

function location(f: ReviewFinding, o: RenderOptions): string {
  const label = f.line ? `${f.file}:${f.line}` : f.file;
  if (!o.repoUrl || !o.sha) return `\`${label}\``;
  return `[\`${label}\`](${o.repoUrl}/blob/${o.sha}/${f.file}${f.line ? `#L${f.line}` : ''})`;
}

/** Single-line text for a table cell or a bullet, without breaking the Markdown around it. */
const inline = (s: string) => s.replace(/\r?\n+/g, ' ').trim();

export function renderMarkdown(r: ReviewResult, o: RenderOptions = {}): string {
  const out: string[] = [REVIEW_MARKER, '## 🤖 AI-ревью кода', ''];
  const added = r.files.reduce((n, f) => n + f.additions, 0);
  const removed = r.files.reduce((n, f) => n + f.deletions, 0);
  out.push(
    `\`${r.base}\` → \`${r.head === 'WORKTREE' ? 'рабочая копия' : r.head}\` · файлов: ${r.files.length} (+${added} −${removed})` +
      (r.ignored.length ? ` · пропущено: ${r.ignored.length}` : ''),
    '',
  );
  // One summary per batch (LLM call), each on its own quoted line.
  if (r.summary) out.push(r.summary.split('\n').map((l) => `> ${inline(l)}`).join('\n>\n'), '');
  if (r.failed.length) {
    out.push(`> ⚠️ Не удалось получить ревью для файлов: ${r.failed.flat().map((f) => `\`${f}\``).join(', ')}`, '');
  }

  const counts = SECTIONS.map((s) => `${s.title.split(' ')[0]} ${r.findings.filter((f) => f.category === s.category).length}`);
  out.push(`**Замечания:** ${counts.join(' · ')}`, '');

  for (const section of SECTIONS) {
    const items = r.findings.filter((f) => f.category === section.category);
    out.push(`### ${section.title}`, '');
    if (!items.length) {
      out.push('_Не найдено._', '');
      continue;
    }
    for (const f of items) {
      out.push(`- **${inline(f.title)}** — ${location(f, o)} · ${SEVERITY[f.severity]}`);
      if (f.details) out.push(`  ${inline(f.details)}`);
      if (f.suggestion) out.push(`  _Как исправить:_ ${inline(f.suggestion)}`);
      if (f.refs.length) out.push(`  _Контекст:_ ${f.refs.map((c) => `\`${c.file}\``).join(', ')}`);
    }
    out.push('');
  }

  out.push('<details><summary>Как сделано ревью</summary>', '');
  out.push(`- Diff: \`${r.mergeBase.slice(0, 7)}\` (merge-base с \`${r.base}\`) → \`${r.head === 'WORKTREE' ? 'рабочая копия' : r.head.slice(0, 12)}\`, LLM-вызовов: ${r.batches}`);
  out.push(`- Файлы: ${r.files.map((f) => `\`${f.path}\` (${f.status}, +${f.additions} −${f.deletions})`).join(', ') || '—'}`);
  if (r.ignored.length) out.push(`- Пропущены (lock/сгенерированные/бинарные): ${r.ignored.map((f) => `\`${f}\``).join(', ')}`);
  if (r.dropped.length) out.push(`- Отброшено замечаний к неизменённым строкам: ${r.dropped.length} (${r.dropped.map((d) => `\`${d.file}:${d.line}\``).join(', ')})`);
  if (r.truncated.length) out.push(`- Diff обрезан (слишком большой): ${r.truncated.map((f) => `\`${f}\``).join(', ')}`);
  if (r.context.length) {
    out.push(`- RAG-контекст (документация и код проекта): ${r.context.map((c) => `\`${c.file}\``).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
  }
  out.push(
    `- Модель: ${r.model ?? '—'}${r.usage ? ` · токенов: ${r.usage.totalTokens}` : ''} · ${(r.durationMs / 1000).toFixed(1)} с`,
    '',
    '</details>',
    '',
  );
  return out.join('\n');
}
