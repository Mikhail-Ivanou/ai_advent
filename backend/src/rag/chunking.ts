import {
  Chunk,
  ChunkMetadata,
  DocSection,
  FixedChunkingParams,
  LoadedDocument,
  StructuralChunkingParams,
} from './rag.types';

export interface ChunkContext {
  docId: string;
  file: string;
}

const SECTION_SEPARATOR = ' › ';
const SENTENCE_END = /[.!?…»"'")\]]\s|[.!?…]$/;

function sectionLabel(path: string[]): string {
  return path.join(SECTION_SEPARATOR);
}

/** Index of the section containing `offset` (or the last one starting before it). */
function sectionAt(sections: DocSection[], offset: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sections[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function countSpanned(sections: DocSection[], start: number, end: number): number {
  const first = sectionAt(sections, start);
  const last = sectionAt(sections, Math.max(start, end - 1));
  return last - first + 1;
}

function makeMetadata(
  doc: LoadedDocument,
  ctx: ChunkContext,
  strategy: ChunkMetadata['strategy'],
  index: number,
  fields: Pick<ChunkMetadata, 'section' | 'start' | 'end' | 'sectionsSpanned' | 'part'>,
): ChunkMetadata {
  return {
    chunk_id: `${strategy}:${ctx.docId}:${index}`,
    source: doc.source,
    title: doc.title,
    file: ctx.file,
    strategy,
    index,
    ...fields,
  };
}

/**
 * Strategy 1 — fixed size: a window of `size` characters slides over the
 * full text with `overlap` characters shared between neighbours, ignoring
 * structure. The only concession is not cutting words: the end snaps back to
 * the nearest sentence/paragraph end in the last fifth of the window (or a
 * space), the start forward to a word boundary.
 */
export function chunkFixed(doc: LoadedDocument, ctx: ChunkContext, params: FixedChunkingParams): Chunk[] {
  const { text, sections } = doc;
  const size = Math.max(100, params.size);
  const overlap = Math.min(Math.max(0, params.overlap), Math.floor(size / 2));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start, end);
      const floor = Math.floor(size * 0.8);
      let cut = -1;
      for (const re of [/\n/g, /[.!?…](?=\s)/g]) {
        for (const m of window.matchAll(re)) if (m.index! >= floor) cut = Math.max(cut, m.index! + 1);
        if (cut > 0) break;
      }
      if (cut < 0) cut = window.lastIndexOf(' ') > floor ? window.lastIndexOf(' ') : window.length;
      end = start + cut;
    }
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) {
      const s = start + lead;
      const e = s + body.length;
      const section = sections[sectionAt(sections, s)];
      chunks.push({
        text: body,
        metadata: makeMetadata(doc, ctx, 'fixed', chunks.length, {
          section: sectionLabel(section.path),
          start: s,
          end: e,
          sectionsSpanned: countSpanned(sections, s, e),
        }),
      });
    }
    if (end >= text.length) break;
    let next = Math.max(start + 1, end - overlap);
    // Start the next window on a word boundary.
    while (next < end && /\S/.test(text[next - 1] ?? ' ')) next++;
    start = next;
  }
  return chunks;
}

interface Piece {
  path: string[];
  text: string;
  start: number;
  end: number;
}

/** Splits text longer than `max` at paragraph, then sentence, then word boundaries. */
function splitLong(text: string, start: number, max: number): { text: string; start: number }[] {
  if (text.length <= max) return [{ text, start }];
  const units: { text: string; start: number }[] = [];
  // Paragraphs first; a paragraph still too long is cut into sentences.
  const re = /[^\n]+/g;
  for (const m of text.matchAll(re)) {
    const para = m[0];
    const pStart = start + m.index!;
    if (para.length <= max) {
      units.push({ text: para, start: pStart });
      continue;
    }
    for (const s of para.matchAll(/[^.!?…]+(?:[.!?…]+["»”)]*\s*|$)/g)) {
      if (!s[0]) continue;
      let sentence = s[0];
      let sStart = pStart + s.index!;
      while (sentence.length > max) {
        const cut = sentence.lastIndexOf(' ', max) > max / 2 ? sentence.lastIndexOf(' ', max) : max;
        units.push({ text: sentence.slice(0, cut), start: sStart });
        sentence = sentence.slice(cut);
        sStart += cut;
      }
      units.push({ text: sentence, start: sStart });
    }
  }
  // Greedily pack the units back into parts of at most `max` characters,
  // slicing by offsets so the line breaks between paragraphs are preserved.
  const result: { text: string; start: number }[] = [];
  let open: { start: number; end: number } | undefined;
  for (const u of units) {
    const uEnd = u.start + u.text.length;
    if (open && uEnd - open.start <= max) open.end = uEnd;
    else {
      if (open) result.push({ start: open.start, text: text.slice(open.start - start, open.end - start) });
      open = { start: u.start, end: uEnd };
    }
  }
  if (open) result.push({ start: open.start, text: text.slice(open.start - start, open.end - start) });
  return result.map((p) => ({ start: p.start + (p.text.length - p.text.trimStart().length), text: p.text.trim() })).filter((p) => p.text);
}

/**
 * Strategy 2 — by structure: one chunk per section (book chapter, markdown /
 * HTML heading block, PDF page, top-level code declaration). A section
 * longer than `maxSize` is split by paragraphs into parts; a section shorter
 * than `minSize` is merged with its sibling or with its parent's text before
 * it, so a chunk never mixes unrelated parts of the document. Each chunk's text starts
 * with its heading path, so a part from the middle of a chapter still
 * carries its context.
 */
export function chunkStructural(doc: LoadedDocument, ctx: ChunkContext, params: StructuralChunkingParams): Chunk[] {
  const maxSize = Math.max(200, params.maxSize);
  const minSize = Math.min(Math.max(0, params.minSize), maxSize);

  // 1. Sections -> pieces, oversized sections split into parts.
  const groups: { path: string[]; parts: Piece[] }[] = [];
  for (const section of doc.sections) {
    const leaf = section.path[section.path.length - 1];
    // A bare heading (no body) is only context — its title is in the children's path.
    if (leaf && section.text.trim() === leaf.trim()) continue;
    groups.push({
      path: section.path,
      parts: splitLong(section.text, section.start, maxSize).map((p) => ({
        path: section.path,
        text: p.text,
        start: p.start,
        end: p.start + p.text.length,
      })),
    });
  }

  // 2. Merge short sections into their neighbour when they belong together:
  // siblings (same parent) or a subsection following its parent's text.
  const parent = (path: string[]) => sectionLabel(path.slice(0, -1));
  const isWithin = (outer: string[], inner: string[]) =>
    inner.length > outer.length && outer.every((title, i) => inner[i] === title);
  const merged: { pieces: Piece[]; part?: string }[] = [];
  for (const group of groups) {
    if (group.parts.length > 1) {
      group.parts.forEach((p, i) => merged.push({ pieces: [p], part: `${i + 1}/${group.parts.length}` }));
      continue;
    }
    const piece = group.parts[0];
    if (!piece) continue;
    const last = merged[merged.length - 1];
    const head = last?.pieces[0];
    if (
      last &&
      head &&
      !last.part &&
      (last.pieces[last.pieces.length - 1].end - head.start < minSize || piece.end - piece.start < minSize) &&
      (parent(head.path) === parent(piece.path) || isWithin(head.path, piece.path)) &&
      piece.end - head.start <= maxSize
    ) {
      last.pieces.push(piece);
    } else {
      merged.push({ pieces: [piece] });
    }
  }

  // 3. Chunks with heading-path headers and metadata.
  return merged.map((m, index) => {
    const first = m.pieces[0];
    const leaves = m.pieces.map((p) => p.path[p.path.length - 1] ?? '').filter(Boolean);
    const siblings = m.pieces.every((p) => parent(p.path) === parent(first.path));
    const section =
      m.pieces.length === 1 || !leaves.length
        ? sectionLabel(first.path)
        : siblings
          ? sectionLabel([...first.path.slice(0, -1), leaves.join(', ')])
          : [sectionLabel(first.path), ...m.pieces.slice(1).map((p) => p.path[p.path.length - 1])].filter(Boolean).join(' + ');
    // Every chunk starts with its full heading path, replacing the section's
    // own (leaf) heading line where the text begins with one.
    const header = sectionLabel(first.path);
    const leaf = first.path[first.path.length - 1];
    let body = m.pieces.map((p) => p.text).join('\n\n');
    if (leaf && body.startsWith(`${leaf}\n`)) body = body.slice(leaf.length + 1);
    const text = header ? `${header}\n${body}` : body;
    const start = first.start;
    const end = m.pieces[m.pieces.length - 1].end;
    return {
      text,
      metadata: makeMetadata(doc, ctx, 'structural', index, {
        section,
        start,
        end,
        sectionsSpanned: m.pieces.length,
        part: m.part,
      }),
    };
  });
}

/** True when the chunk ends mid-sentence (not at a paragraph end or sentence punctuation). */
export function endsMidSentence(fullText: string, chunk: Chunk): boolean {
  const next = fullText[chunk.metadata.end];
  if (next === undefined || next === '\n') return false;
  return !SENTENCE_END.test(chunk.text.slice(-2));
}
