import { HTMLElement, Node, NodeType, parse } from 'node-html-parser';
import { DocSection, DocumentKind, LoadedDocument } from './rag.types';

// pdf-parse's index.js runs a self-test on require when it thinks it's the
// main module; the lib entry point is the actual parser.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (data: Buffer, options?: Record<string, unknown>) => Promise<{ info?: { Title?: string } }> = require('pdf-parse/lib/pdf-parse.js');

const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp',
  'swift', 'scala', 'sh', 'sql', 'css', 'scss', 'vue', 'svelte',
]);

/**
 * Accumulates sections into one full text, recording each section's offsets
 * in it — chunkers work on the full text and map offsets back to sections.
 */
class SectionBuilder {
  private text = '';
  readonly sections: DocSection[] = [];

  add(path: string[], paragraphs: string[]): void {
    const body = paragraphs.map((p) => p.trim()).filter(Boolean).join('\n');
    if (!body) return;
    if (this.text) this.text += '\n\n';
    const start = this.text.length;
    this.text += body;
    this.sections.push({ path: [...path], text: body, start, end: this.text.length });
  }

  build(source: string, title: string, kind: DocumentKind): LoadedDocument {
    if (!this.text.trim()) throw new Error(`No text could be extracted from ${source}`);
    return { source, title: title.trim() || source, kind, text: this.text, sections: this.sections };
  }
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.fb2.zip')) return 'fb2.zip';
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1) : '';
}

export function baseName(source: string): string {
  try {
    const url = new URL(source);
    const segments = url.pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? url.hostname);
  } catch {
    return source.split(/[\\/]/).pop() ?? source;
  }
}

/** FB2 and old HTML often declare a legacy encoding (windows-1251); honour it. */
function decodeText(data: Buffer, contentType?: string): string {
  const head = data.subarray(0, 1024).toString('latin1');
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(declared.toLowerCase()).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

// ---------------------------------------------------------------- FB2

/** FB2 block elements whose text forms one paragraph each. */
const FB2_TEXT_BLOCKS = new Set(['p', 'subtitle', 'v', 'text-author', 'td', 'th']);

function fb2Paragraphs(el: HTMLElement, out: string[]): void {
  for (const child of el.childNodes) {
    if (!(child instanceof HTMLElement)) continue;
    const tag = child.rawTagName?.toLowerCase();
    if (tag === 'section' || tag === 'title') continue;
    if (FB2_TEXT_BLOCKS.has(tag)) out.push(collapse(child.textContent));
    else fb2Paragraphs(child, out); // epigraph, poem, stanza, cite, table…
  }
}

function fb2Title(section: HTMLElement): string | undefined {
  const title = section.childNodes.find(
    (c): c is HTMLElement => c instanceof HTMLElement && c.rawTagName?.toLowerCase() === 'title',
  );
  if (!title) return undefined;
  const lines = title.querySelectorAll('p').map((p) => collapse(p.textContent)).filter(Boolean);
  // "Глава первая" + "Декабрь 1998." -> "Глава первая. Декабрь 1998." (no double dot when a line already ends with one).
  const joined = lines.reduce((acc, line) => (!acc ? line : /[.!?…:;]$/.test(acc) ? `${acc} ${line}` : `${acc}. ${line}`), '');
  return (joined || collapse(title.textContent)) || undefined;
}

function walkFb2Section(section: HTMLElement, path: string[], builder: SectionBuilder): void {
  const title = fb2Title(section);
  const here = title ? [...path, title] : path;
  // Text directly in this section, interrupted by nested sections: each run
  // of paragraphs becomes its own DocSection with this section's path.
  let pending: string[] = title ? [title] : [];
  const flush = () => {
    // A heading with no body (e.g. "Часть первая" wrapping chapters) is not
    // a section of its own — its title lives on in the children's path.
    if (pending.length > (title && pending[0] === title ? 1 : 0)) builder.add(here, pending);
    pending = [];
  };
  for (const child of section.childNodes) {
    if (!(child instanceof HTMLElement)) continue;
    const tag = child.rawTagName?.toLowerCase();
    if (tag === 'title') continue;
    if (tag === 'section') {
      flush();
      walkFb2Section(child, here, builder);
    } else if (FB2_TEXT_BLOCKS.has(tag)) {
      pending.push(collapse(child.textContent));
    } else {
      fb2Paragraphs(child, pending);
    }
  }
  flush();
}

function loadFb2(source: string, data: Buffer): LoadedDocument {
  // Embedded images (<binary>) can be most of the file and carry no text.
  const xml = decodeText(data).replace(/<binary[\s\S]*?<\/binary>/gi, '');
  const root = parse(xml, { lowerCaseTagName: false, comment: false });
  const bookTitle = collapse(root.querySelector('book-title')?.textContent ?? '');
  const builder = new SectionBuilder();
  for (const body of root.querySelectorAll('body')) {
    const name = body.getAttribute('name');
    const path = name === 'notes' ? ['Примечания'] : name ? [name] : [];
    walkFb2Section(body, path, builder);
  }
  return builder.build(source, bookTitle || baseName(source), 'fb2');
}

// ---------------------------------------------------------------- Markdown

function loadMarkdown(source: string, raw: string): LoadedDocument {
  const builder = new SectionBuilder();
  const stack: { level: number; title: string }[] = [];
  let paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let firstH1: string | undefined;
  const flushParagraph = () => {
    if (current.length) paragraphs.push(current.join(inFence ? '\n' : ' '));
    current = [];
  };
  const flushSection = () => {
    flushParagraph();
    builder.add(stack.map((h) => h.title), paragraphs);
    paragraphs = [];
  };
  for (const rawLine of raw.replace(/\r\n?/g, '\n').split('\n')) {
    // Inline HTML in READMEs (badges, <p align>) is markup, not text.
    const line = /^\s*(```|~~~)/.test(rawLine) || inFence ? rawLine : rawLine.replace(/<[^>]+>/g, ' ');
    if (/^\s*(```|~~~)/.test(line)) {
      // Code blocks are kept verbatim as one paragraph.
      if (inFence) {
        current.push(line);
        flushParagraph();
        inFence = false;
      } else {
        flushParagraph();
        inFence = true;
        current.push(line);
      }
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushSection();
      const level = heading[1].length;
      const title = heading[2].trim();
      if (level === 1 && !firstH1) firstH1 = title;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      paragraphs.push(title);
      continue;
    }
    if (!line.trim()) flushParagraph();
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      // A list item is a paragraph of its own.
      flushParagraph();
      current.push(line.trim());
    } else current.push(line.trim());
  }
  flushSection();
  return builder.build(source, firstH1 ?? baseName(source), 'markdown');
}

// ---------------------------------------------------------------- HTML

const HTML_DROP =
  'script, style, noscript, svg, nav, footer, header, aside, form, iframe, template, button, ' +
  '.mw-editsection, sup.reference, .reference, .navbox, .catlinks, .mw-jump-link, .toc, #toc, ' +
  // Wikipedia: reference lists, maintenance notices, TeX source of formulas.
  '.reflist, .references, .mw-references-wrap, .ambox, .metadata, .noprint, annotation';

const HTML_BLOCKS =
  'p, div, ul, ol, li, table, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, section, article, dl, figure, br, hr';

const HTML_PARAGRAPHS = new Set(['p', 'li', 'pre', 'blockquote', 'dt', 'dd', 'figcaption', 'caption', 'tr']);

function loadHtml(source: string, raw: string): LoadedDocument {
  const doc = parse(raw, { comment: false, blockTextElements: { script: false, style: false, pre: true } });
  const pageTitle = collapse(doc.querySelector('title')?.textContent ?? '');
  doc.querySelectorAll(HTML_DROP).forEach((el) => el.remove());
  const root =
    doc.querySelector('#mw-content-text') ??
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role=main]') ??
    doc.querySelector('body') ??
    doc;

  const builder = new SectionBuilder();
  const stack: { level: number; title: string }[] = [];
  let paragraphs: string[] = [];
  let firstH1: string | undefined;
  const flushSection = () => {
    builder.add(stack.map((h) => h.title), paragraphs);
    paragraphs = [];
  };
  const walk = (node: Node) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = collapse(node.textContent);
      if (text) paragraphs.push(text);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.rawTagName?.toLowerCase() ?? '';
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const title = collapse(node.textContent);
      if (!title) return;
      flushSection();
      const level = Number(heading[1]);
      if (level === 1 && !firstH1) firstH1 = title;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      paragraphs.push(title);
      return;
    }
    // An element with only inline content (text, links, <b>…) is one paragraph,
    // not a fragment per text node.
    if (HTML_PARAGRAPHS.has(tag) || !node.querySelector(HTML_BLOCKS)) {
      const text = tag === 'pre' ? node.textContent.trim() : collapse(node.textContent);
      if (text) paragraphs.push(tag === 'li' ? `• ${text}` : text);
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  flushSection();
  // Text inline in <div>s arrives as many small fragments; that's fine for
  // chunking, which repacks paragraphs anyway.
  return builder.build(source, firstH1 || pageTitle || baseName(source), 'html');
}

// ---------------------------------------------------------------- Code

// A new top-level declaration starts a section: TS/JS, Python, Go, Rust, Java-ish.
const CODE_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(function\*?|class|interface|type|enum|const|let|var|def|func|fn|struct|impl|trait|module|namespace)\s+([A-Za-z_$][\w$]*)/;

function loadCode(source: string, raw: string): LoadedDocument {
  const builder = new SectionBuilder();
  let path: string[] = [];
  let lines: string[] = [];
  let pendingComments: string[] = [];
  const flush = () => {
    // Paragraphs are blank-line separated groups, kept with their line breaks.
    const paragraphs = lines.join('\n').split(/\n\s*\n/);
    builder.add(path, paragraphs);
    lines = [];
  };
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    // Leading comments/decorators belong to the declaration that follows them.
    if (/^(\/\/|\/\*|\*|#(?!!)|@\w)/.test(line) || (pendingComments.length && /^\s+\*/.test(line))) {
      pendingComments.push(line);
      continue;
    }
    const decl = CODE_DECLARATION.exec(line);
    if (decl) {
      flush();
      path = [`${decl[1]} ${decl[2]}`];
    }
    lines.push(...pendingComments, line);
    pendingComments = [];
  }
  lines.push(...pendingComments);
  flush();
  return builder.build(source, baseName(source), 'code');
}

// ---------------------------------------------------------------- PDF / text

async function loadPdf(source: string, data: Buffer): Promise<LoadedDocument> {
  const pages: string[] = [];
  const info = await pdfParse(data, {
    pagerender: async (page: { getTextContent: () => Promise<{ items: { str: string; hasEOL?: boolean }[] }> }) => {
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
      pages.push(text);
      return text;
    },
  });
  const builder = new SectionBuilder();
  pages.forEach((page, i) => {
    // Lines of one paragraph are joined; a blank line or a short line ending
    // with a full stop ends the paragraph. Hyphenated line breaks are healed.
    const paragraphs = page
      .replace(/-\n(?=\p{Ll})/gu, '')
      .split(/\n\s*\n|(?<=[.!?:])\n(?=\p{Lu})/u)
      .map(collapse);
    builder.add([`стр. ${i + 1}`], paragraphs);
  });
  return builder.build(source, info.info?.Title || baseName(source), 'pdf');
}

function loadText(source: string, raw: string): LoadedDocument {
  const builder = new SectionBuilder();
  builder.add([], raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(collapse));
  return builder.build(source, baseName(source), 'text');
}

// ---------------------------------------------------------------- entry points

function detectKind(name: string, contentType: string | undefined, data: Buffer): DocumentKind | 'fb2.zip' {
  const ext = extensionOf(name);
  const type = (contentType ?? '').toLowerCase();
  if (ext === 'fb2.zip') return 'fb2.zip';
  if (ext === 'fb2' || type.includes('fictionbook')) return 'fb2';
  if (ext === 'pdf' || type.includes('application/pdf') || data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (['md', 'markdown', 'mdx'].includes(ext) || type.includes('markdown')) return 'markdown';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (['html', 'htm', 'xhtml'].includes(ext) || type.includes('html')) return 'html';
  const head = data.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.includes('<fictionbook')) return 'fb2';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  return 'text';
}

/** Turns raw bytes (an uploaded file or a download) into a section tree. */
export async function loadDocument(source: string, data: Buffer, contentType?: string): Promise<LoadedDocument> {
  const kind = detectKind(baseName(source), contentType, data);
  switch (kind) {
    case 'fb2.zip':
      throw new Error('Zipped FB2 is not supported — unpack the .fb2 file first');
    case 'fb2':
      return loadFb2(source, data);
    case 'pdf':
      return loadPdf(source, data);
    case 'markdown':
      return loadMarkdown(source, decodeText(data, contentType));
    case 'html':
      return loadHtml(source, decodeText(data, contentType));
    case 'code':
      return loadCode(source, decodeText(data, contentType));
    default:
      return loadText(source, decodeText(data, contentType));
  }
}

export async function loadFromUrl(url: string): Promise<LoadedDocument> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'advent-rag-indexer/1.0', Accept: 'text/html,text/markdown,text/plain,application/pdf,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_DOWNLOAD_BYTES) throw new Error(`Document is too large (${length} bytes)`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_DOWNLOAD_BYTES) throw new Error(`Document is too large (${data.length} bytes)`);
  return loadDocument(url, data, response.headers.get('content-type') ?? undefined);
}
