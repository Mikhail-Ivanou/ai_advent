import { ReactNode } from 'react';

// Day 32: renders the AI code review (backend/src/review/render.ts) in the
// developer assistant; Day 33: also the support assistant's answers. Only a
// small subset: ##/### headings, "> " quotes, "- " bullets with indented
// continuation lines, "1." numbered lists, "---" rules, **bold**, _italic_,
// `code`, [links](url) and <details><summary> blocks. Built as React
// elements — no HTML from the model ever reaches the DOM.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w])_[^_]+_(?![\w]))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-black/5 px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const safe = /^https?:\/\//.test(link[2]);
      return safe ? (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-pine underline">
          {inline(link[1])}
        </a>
      ) : (
        <span key={i}>{inline(link[1])}</span>
      );
    }
    if (/^_[^_]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('<!--')) continue;
    if (line.startsWith('<details>')) {
      const end = lines.findIndex((l, j) => j > i && l.startsWith('</details>'));
      const summary = /<summary>(.*?)<\/summary>/.exec(line)?.[1] ?? 'Подробнее';
      out.push(
        <details key={i} className="mt-2 text-xs text-[#5c5c5c]">
          <summary className="cursor-pointer">{summary}</summary>
          <div className="mt-1">{blocks(lines.slice(i + 1, end < 0 ? lines.length : end))}</div>
        </details>,
      );
      i = end < 0 ? lines.length : end;
      continue;
    }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        heading[1] === '##' ? (
          <h3 key={i} className="mb-1 text-base font-medium">
            {inline(heading[2])}
          </h3>
        ) : (
          <h4 key={i} className="mb-1 mt-3 font-medium text-pine">
            {inline(heading[2])}
          </h4>
        ),
      );
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      i--;
      out.push(
        <blockquote key={i} className="my-2 space-y-1 border-l-2 border-pine/40 pl-2 text-[#3c3c3c]">
          {quote.filter(Boolean).map((q, j) => (
            <p key={j}>{inline(q)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push(<hr key={i} className="my-2 border-black/10" />);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[][] = [];
      for (; i < lines.length && (/^\d+\.\s/.test(lines[i]) || /^\s{2,}\S/.test(lines[i])); i++) {
        if (/^\d+\.\s/.test(lines[i])) items.push([lines[i].replace(/^\d+\.\s+/, '')]);
        else items[items.length - 1]?.push(lines[i].trim());
      }
      i--;
      out.push(
        <ol key={i} className="my-1 list-decimal space-y-1 pl-5">
          {items.map(([head, ...rest], j) => (
            <li key={j}>
              {inline(head)}
              {rest.map((r, k) => (
                <div key={k} className="text-[0.95em] text-[#3c3c3c]">
                  {inline(r)}
                </div>
              ))}
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[][] = [];
      for (; i < lines.length && (/^[-*] /.test(lines[i]) || lines[i].startsWith('  ')); i++) {
        if (/^[-*] /.test(lines[i])) items.push([lines[i].slice(2)]);
        else items[items.length - 1]?.push(lines[i].trim());
      }
      i--;
      out.push(
        <ul key={i} className="my-1 space-y-2">
          {items.map(([head, ...rest], j) => (
            <li key={j} className="list-none">
              <div>{inline(head)}</div>
              {rest.map((r, k) => (
                <div key={k} className="pl-3 text-[0.95em] text-[#3c3c3c]">
                  {inline(r)}
                </div>
              ))}
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    out.push(
      <p key={i} className="my-1">
        {inline(line)}
      </p>,
    );
  }
  return out;
}

/** Also exported under a neutral name for other assistants' answers. */
export function Markdown({ text }: { text: string }) {
  return <div className="text-sm">{blocks(text.split('\n'))}</div>;
}

export function ReviewMarkdown({ text }: { text: string }) {
  return <div className="text-sm">{blocks(text.split('\n'))}</div>;
}
