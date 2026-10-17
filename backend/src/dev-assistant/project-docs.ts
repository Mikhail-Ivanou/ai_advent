import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { chunkStructural } from '../rag/chunking';
import { dot, embed, EMBEDDING_MODEL } from '../rag/embedder';
import { Bm25Index } from '../rag/lexical';
import { loadDocument } from '../rag/loaders';
import { DocumentKind, IndexedChunk, SearchHit } from '../rag/rag.types';

// Day 31: the developer assistant's own RAG index — the project's
// documentation, not the user's uploaded books. The corpus is collected from
// the repository on every start: the READMEs, everything in docs/, the
// backend's HTTP API (generated from the Nest controllers, so it can't go
// stale), the data schemas (*.types.ts) and the iOS client's Swift sources —
// small enough to index whole, and its models and gateway client are the
// app's API description. Chunks of unchanged files are
// reused by content hash, so a restart re-embeds only what was edited.

export const REPO_DIR = path.resolve(process.env.DEV_ASSISTANT_REPO_DIR?.trim() || path.join(process.cwd(), '..'));
const INDEX_PATH = path.join(process.cwd(), 'data', 'dev-assistant', 'index.json');
const STRUCTURAL = { maxSize: 1400, minSize: 300 };
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'data', 'build', 'img']);

/** What a document of the corpus is, for the UI and the model. */
export type ProjectDocGroup = 'readme' | 'docs' | 'api' | 'schema' | 'ios';

export interface ProjectDoc {
  /** Repository-relative path; the generated API reference has a virtual one. */
  path: string;
  group: ProjectDocGroup;
  content: string;
}

export interface ProjectDocInfo {
  path: string;
  group: ProjectDocGroup;
  title: string;
  kind: DocumentKind;
  hash: string;
  chars: number;
  chunks: number;
}

interface ProjectIndexFile {
  version: 1;
  embeddingModel: string;
  builtAt: string;
  documents: ProjectDocInfo[];
  chunks: IndexedChunk[];
}

export interface IndexStats {
  builtAt: string;
  embeddingModel: string;
  documents: ProjectDocInfo[];
  chunks: number;
  /** Files re-embedded by the last build (the rest were reused). */
  reembedded: string[];
  buildMs: number;
}

async function walk(dir: string, accept: (rel: string) => boolean, out: string[] = []): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, accept, out);
    else if (accept(path.relative(REPO_DIR, full))) out.push(full);
  }
  return out;
}

const HTTP_DECORATOR = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/;

/**
 * Markdown reference of the backend's HTTP API, read from the controllers:
 * every route with its method, full path, handler signature (body/query
 * types) and doc comment.
 */
export function describeControllers(files: { path: string; content: string }[]): string {
  const out = [
    '# Backend API (HTTP)',
    'Сгенерировано из Nest-контроллеров backend/src/**/*.controller.ts при индексации. Бэкенд слушает http://localhost:3001 без глобального префикса; веб-приложение проксирует его как /api/backend/*.',
  ];
  for (const file of files) {
    const base = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(file.content);
    if (!base) continue;
    const prefix = base[1] ? `/${base[1]}` : '';
    const lines = file.content.split('\n');
    const classLine = lines.findIndex((l) => /export class \w+/.test(l));
    const className = /export class (\w+)/.exec(lines[classLine] ?? '')?.[1] ?? '';
    const classDoc = docCommentBefore(lines, lines.findIndex((l) => l.includes('@Controller(')));
    out.push('', `## ${prefix || '/'} — ${className}`, `Файл: ${file.path}${classDoc ? `. ${classDoc}` : ''}`);
    lines.forEach((line, i) => {
      const route = HTTP_DECORATOR.exec(line);
      if (!route) return;
      const sub = route[2] ? `/${route[2]}` : '';
      // The handler is the first line after the decorators.
      let j = i + 1;
      while (j < lines.length && /^\s*@/.test(lines[j])) j++;
      const signature = (lines[j] ?? '').trim().replace(/\s*\{$/, '');
      const doc = docCommentBefore(lines, i);
      out.push(`- ${route[1].toUpperCase()} ${prefix}${sub || ''}${!prefix && !sub ? '/' : ''} — ${signature}${doc ? ` — ${doc}` : ''}`);
    });
  }
  return out.join('\n');
}

/** The /** … *\/ or // comment right above line `index` (skipping decorators), flattened. */
function docCommentBefore(lines: string[], index: number): string {
  let i = index - 1;
  while (i >= 0 && /^\s*@/.test(lines[i])) i--;
  const collected: string[] = [];
  if (i >= 0 && /\*\/\s*$/.test(lines[i])) {
    for (; i >= 0; i--) {
      collected.unshift(lines[i]);
      if (/\/\*\*?/.test(lines[i])) break;
    }
  } else {
    for (; i >= 0 && /^\s*\/\//.test(lines[i]); i--) collected.unshift(lines[i]);
  }
  return collected
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, '').replace(/\*\/\s*$/, '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Collects the corpus from the repository: READMEs, docs/, the API reference, data schemas and the iOS app. */
export async function collectProjectDocs(): Promise<ProjectDoc[]> {
  const read = async (files: string[], group: ProjectDocGroup) =>
    Promise.all(
      files.sort().map(async (full) => ({ path: path.relative(REPO_DIR, full), group, content: await fs.readFile(full, 'utf8') })),
    );
  const readmes = await walk(REPO_DIR, (rel) => /(^|\/)README\.md$/i.test(rel) && rel.split('/').length <= 3);
  const docs = await walk(path.join(REPO_DIR, 'docs'), (rel) => rel.endsWith('.md'));
  const controllers = await walk(path.join(REPO_DIR, 'backend', 'src'), (rel) => rel.endsWith('.controller.ts'));
  const schemas = [
    ...(await walk(path.join(REPO_DIR, 'backend', 'src'), (rel) => rel.endsWith('.types.ts'))),
    ...(await walk(path.join(REPO_DIR, 'mcp-weather', 'src'), (rel) => rel.endsWith('.types.ts'))),
  ];
  const swift = await walk(path.join(REPO_DIR, 'ios'), (rel) => rel.endsWith('.swift'));
  const api = await read(controllers, 'api');
  return [
    ...(await read(readmes, 'readme')),
    ...(await read(docs, 'docs')),
    { path: 'backend/API.md (сгенерировано из контроллеров)', group: 'api', content: describeControllers(api) },
    ...(await read(schemas, 'schema')),
    ...(await read(swift, 'ios')),
  ];
}

const hashOf = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const slug = (p: string) => p.replace(/[^\w.-]+/g, '_');
/** What gets embedded and matched lexically: the file path tells "backend README" from "llm-gateway README". */
const searchable = (c: IndexedChunk) => `${c.metadata.file}\n${c.text}`;

export class ProjectDocsIndex {
  private index?: ProjectIndexFile;
  private bm25?: Bm25Index;
  private building?: Promise<IndexStats>;
  private lastStats?: IndexStats;

  get stats(): IndexStats | undefined {
    return this.lastStats;
  }

  /** Builds (or refreshes) the index; concurrent callers share one build. */
  ensure(force = false): Promise<IndexStats> {
    if (this.lastStats && !force) return Promise.resolve(this.lastStats);
    this.building ??= this.build().finally(() => (this.building = undefined));
    return this.building;
  }

  private async build(): Promise<IndexStats> {
    const started = Date.now();
    const previous = await fs
      .readFile(INDEX_PATH, 'utf8')
      .then((raw) => JSON.parse(raw) as ProjectIndexFile)
      .catch(() => undefined);
    const reusable = previous?.embeddingModel === EMBEDDING_MODEL ? previous : undefined;

    const docs = await collectProjectDocs();
    const documents: ProjectDocInfo[] = [];
    const chunks: IndexedChunk[] = [];
    const reembedded: string[] = [];
    for (const doc of docs) {
      const hash = hashOf(doc.content);
      const old = reusable?.documents.find((d) => d.path === doc.path && d.hash === hash);
      if (old) {
        documents.push(old);
        chunks.push(...reusable!.chunks.filter((c) => c.metadata.source === doc.path));
        continue;
      }
      // The generated API reference is markdown, whatever its virtual name says.
      const name = doc.group === 'api' ? 'API.md' : doc.path;
      let loaded;
      try {
        loaded = await loadDocument(name, Buffer.from(doc.content, 'utf8'));
      } catch {
        continue; // empty file
      }
      loaded.source = doc.path;
      const pieces = chunkStructural(loaded, { docId: slug(doc.path), file: doc.path }, STRUCTURAL);
      const embedded = await embed(
        pieces.map((p) => `${doc.path}\n${p.text}`),
        'passage',
      );
      pieces.forEach((p, i) => chunks.push({ ...p, tokens: embedded[i].tokens, embedding: embedded[i].vector }));
      documents.push({
        path: doc.path,
        group: doc.group,
        title: loaded.title,
        kind: loaded.kind,
        hash,
        chars: doc.content.length,
        chunks: pieces.length,
      });
      reembedded.push(doc.path);
    }

    const file: ProjectIndexFile = { version: 1, embeddingModel: EMBEDDING_MODEL, builtAt: new Date().toISOString(), documents, chunks };
    if (reembedded.length || !previous || previous.documents.length !== documents.length) {
      await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
      await fs.writeFile(INDEX_PATH, JSON.stringify(file));
    } else {
      file.builtAt = previous.builtAt;
    }
    this.index = file;
    this.bm25 = new Bm25Index(chunks.map(searchable));
    this.lastStats = {
      builtAt: file.builtAt,
      embeddingModel: EMBEDDING_MODEL,
      documents,
      chunks: chunks.length,
      reembedded,
      buildMs: Date.now() - started,
    };
    return this.lastStats;
  }

  /**
   * Hybrid search: embeddings and BM25 ranked separately and fused by
   * reciprocal rank (as in Day 22) — exact names like "llm-gateway" or
   * "TaskMemory" are caught literally, paraphrases by the vectors.
   */
  async search(query: string, k = 6): Promise<SearchHit[]> {
    await this.ensure();
    const chunks = this.index!.chunks;
    if (!chunks.length) return [];
    const [q] = await embed([query], 'query');
    const cosine = chunks.map((c) => dot(q.vector, c.embedding));
    const lexical = this.bm25!.scores(query);
    const rank = (scores: number[]) => {
      const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
      const r = new Array<number>(scores.length);
      order.forEach(([s, i], pos) => (r[i] = s > 0 ? pos : Infinity));
      return r;
    };
    const vr = rank(cosine);
    const lr = rank(lexical);
    const fused = chunks.map((_, i) => 1 / (60 + vr[i]) + (Number.isFinite(lr[i]) ? 1 / (60 + lr[i]) : 0));
    return fused
      .map((f, i) => ({ f, i }))
      .sort((a, b) => b.f - a.f)
      .slice(0, k)
      .map(({ i }) => this.hit(i, cosine[i], lexical[i]));
  }

  /**
   * The root README's opening chunks — what the project is, its layout, how
   * to run it. They orient any answer, and a Russian question ("как
   * запустить?") doesn't reliably find the English "Getting started" by
   * similarity, so they're always added to the context.
   */
  overview(count = 2): SearchHit[] {
    const chunks = this.index?.chunks ?? [];
    return chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.metadata.file === 'README.md' && c.metadata.index < count)
      .map(({ i }) => this.hit(i, 0, 0));
  }

  private hit(i: number, score: number, lexical: number): SearchHit {
    const c = this.index!.chunks[i];
    return { score, lexical, metadata: c.metadata, text: c.text };
  }
}
