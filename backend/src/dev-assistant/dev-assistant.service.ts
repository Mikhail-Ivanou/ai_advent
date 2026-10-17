import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { callLlm, ChatMessage, LlmUsage, ToolCallLog } from '../llm/llm.client';
import { SearchHit } from '../rag/rag.types';
import { renderMarkdown } from '../review/render';
import { CodeReviewer } from '../review/reviewer';
import { BranchInfo, GitMcpClient } from './git-mcp.client';
import { DOC_GROUPS, IndexStats, ProjectDocsIndex } from './project-docs';

// Day 31: developer assistant. Messages are commands:
//   /help <question> — answers about the project from its documentation (RAG)
//                      and its live state (git through MCP), with sources;
//   /help            — the same for "what is this project and how is it laid out";
// plus a few direct shortcuts to the MCP server that need no LLM. Plain text
// without a command is treated as /help.

export interface DevSource {
  n: number;
  file: string;
  section: string;
  /** Cosine similarity to the question; 0 for the always-included README overview. */
  score: number;
  /** The answer refers to it as [n]. */
  cited: boolean;
  text: string;
}

export interface DevAssistantReply {
  command: string;
  question?: string;
  answer: string;
  branch?: BranchInfo;
  /** Why the git context is missing, when the MCP server could not be reached. */
  gitError?: string;
  sources?: DevSource[];
  toolCalls?: ToolCallLog[];
  model?: string;
  usage?: LlmUsage;
  durationMs: number;
}

export const COMMANDS: { name: string; args?: string; description: string }[] = [
  { name: '/help', args: '[вопрос]', description: 'ответ о проекте по документации (RAG) и состоянию репозитория (MCP git)' },
  { name: '/branch', description: 'текущая git-ветка и последний коммит (MCP)' },
  { name: '/status', description: 'незакоммиченные изменения (MCP)' },
  { name: '/files', args: '[каталог]', description: 'структура проекта: каталоги и число файлов (MCP)' },
  { name: '/diff', args: '[ветка]', description: 'изменённые файлы: рабочая копия или ветка относительно указанной (MCP)' },
  { name: '/review', args: '[ветка]', description: 'AI-ревью изменений текущей ветки и рабочей копии относительно ветки (по умолчанию main): баги, архитектура, рекомендации' },
  { name: '/docs', description: 'что проиндексировано для RAG' },
  { name: '/reindex', description: 'переиндексировать документацию' },
];

const OVERVIEW_QUESTION = 'Что это за проект, из каких частей он состоит и как его запустить?';
const TOP_K = 6;


function formatBranch(b: BranchInfo): string {
  const tracking = b.upstream ? `, upstream ${b.upstream} (впереди на ${b.ahead}, позади на ${b.behind})` : ', без upstream';
  return `Ветка ${b.detached ? 'detached HEAD' : b.branch}${tracking}; последний коммит ${b.head.sha} «${b.head.subject}» (${b.head.date.slice(0, 10)})`;
}

@Injectable()
export class DevAssistantService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DevAssistantService.name);
  readonly docs = new ProjectDocsIndex();
  readonly git = new GitMcpClient();
  /** Day 32: shares the project index — documentation and code. */
  private readonly reviewer = new CodeReviewer(this.docs);

  onApplicationBootstrap() {
    // Built in the background: the first /help waits for it if it's still running.
    void this.docs
      .ensure()
      .then((s) => this.logger.log(`Project docs indexed: ${s.documents.length} files, ${s.chunks} chunks, re-embedded ${s.reembedded.length} (${s.buildMs} ms)`))
      .catch((error) => this.logger.warn(`Project docs indexing failed: ${(error as Error).message}`));
  }

  async status() {
    const [docs, branch] = await Promise.all([
      this.docs.ensure(),
      this.git.currentBranch().then(
        (b) => ({ branch: b }),
        (e: Error) => ({ gitError: e.message }),
      ),
    ]);
    const tools = await this.git.listTools().then((t) => t.map((x) => x.name)).catch(() => []);
    return { ...branch, mcpUrl: this.git.url, mcpTools: tools, docs: summarizeDocs(docs), commands: COMMANDS };
  }

  async handle(message: string, history: ChatMessage[] = [], model?: string): Promise<DevAssistantReply> {
    const started = Date.now();
    const text = message.trim();
    const match = /^(\/[\w-]+)\s*([\s\S]*)$/.exec(text);
    const command = match ? match[1].toLowerCase() : '/help';
    const arg = match ? match[2].trim() : text;
    const done = (reply: Omit<DevAssistantReply, 'durationMs' | 'command'>): DevAssistantReply => ({
      command,
      ...reply,
      durationMs: Date.now() - started,
    });

    switch (command) {
      case '/help':
        return { ...(await this.help(arg, history, model)), command, durationMs: Date.now() - started };
      case '/branch': {
        const b = await this.git.currentBranch();
        return done({ answer: formatBranch(b), branch: b });
      }
      case '/status':
        return done({ answer: (await this.git.call('git_status')).text });
      case '/files':
        return done({ answer: (await this.git.call('git_list_files', { ...(arg ? { path: arg } : {}), depth: 2 })).text });
      case '/diff':
        return done({ answer: (await this.git.call('git_diff', { ...(arg ? { base: arg } : {}), stat_only: true })).text });
      case '/review': {
        const result = await this.reviewer.review({ base: arg || 'main', worktree: true, model });
        return done({ answer: renderMarkdown(result).replace(/^<!--.*-->\n/, ''), model: result.model, usage: result.usage });
      }
      case '/docs': {
        const s = await this.docs.ensure();
        const docs = s.documents.filter((d) => d.group !== 'code');
        const code = s.documents.filter((d) => d.group === 'code');
        const lines = docs.map((d) => `• ${d.path} — ${d.chunks} чанк(ов)`);
        const codeChunks = code.reduce((n, d) => n + d.chunks, 0);
        return done({
          answer: `В индексе ${s.documents.length} файлов, ${s.chunks} чанков (${s.embeddingModel}).\nДокументация (для /help):\n${lines.join('\n')}\nИсходный код (для /review): ${code.length} файлов, ${codeChunks} чанков.`,
        });
      }
      case '/reindex': {
        const s = await this.docs.ensure(true);
        return done({
          answer: `Переиндексировано за ${s.buildMs} мс: ${s.documents.length} файлов, ${s.chunks} чанков. Заново посчитаны эмбеддинги: ${s.reembedded.length ? s.reembedded.join(', ') : 'ничего не менялось'}.`,
        });
      }
      default:
        return done({
          answer: `Неизвестная команда ${command}. Доступно:\n${COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`).join('\n')}`,
        });
    }
  }

  /**
   * /help: the git state comes first (it's cheap and always relevant), then
   * the documentation excerpts for the question; both go to the model as
   * project context, and the git tools stay available for what the docs
   * don't say (exact files, code, the branch's diff).
   */
  private async help(question: string, history: ChatMessage[], model?: string): Promise<Omit<DevAssistantReply, 'durationMs' | 'command'>> {
    const asked = question || OVERVIEW_QUESTION;
    const [git, found, toolset] = await Promise.all([
      this.gitContext(),
      this.docs.search(asked, TOP_K, { groups: DOC_GROUPS }),
      this.git.toolset().catch(() => undefined),
    ]);
    // Found excerpts first, then the README overview unless it was found anyway.
    const ids = new Set(found.map((h) => h.metadata.chunk_id));
    const hits = [...found, ...this.docs.overview().filter((h) => !ids.has(h.metadata.chunk_id))];
    const stats = this.docs.stats;
    const projectContext = [
      `Текущее состояние репозитория (MCP git): ${git.text}`,
      stats ? `Проиндексированная документация: ${stats.documents.filter((d) => d.group !== 'code').map((d) => d.path).join(', ')}` : '',
      `Фрагменты документации:\n${formatExcerpts(hits)}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await callLlm(
      asked,
      { model: model ?? (process.env.DEV_ASSISTANT_MODEL?.trim() || undefined), temperature: 0.2, history: history.slice(-6), projectContext, tools: toolset },
      'dev-assistant:help',
    );
    const cited = new Set([...result.content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return {
      question: asked,
      answer: result.content.trim(),
      branch: git.branch,
      gitError: git.error,
      sources: hits.map((h, i) => ({
        n: i + 1,
        file: h.metadata.file,
        section: h.metadata.section,
        score: Math.round(h.score * 1000) / 1000,
        cited: cited.has(i + 1),
        text: h.text,
      })),
      toolCalls: result.toolCalls,
      model: result.model,
      usage: result.usage,
    };
  }

  private async gitContext(): Promise<{ text: string; branch?: BranchInfo; error?: string }> {
    try {
      const [branch, status] = await Promise.all([this.git.currentBranch(), this.git.call('git_status')]);
      const changed = (status.structured?.files as unknown[] | undefined)?.length ?? 0;
      return {
        branch,
        text: `${formatBranch(branch)}; незакоммиченных изменений: ${changed ? `${changed} файл(ов)` : 'нет'}.`,
      };
    } catch (error) {
      const message = (error as Error).message;
      return { text: `недоступно — ${message}`, error: message };
    }
  }
}

function formatExcerpts(hits: SearchHit[]): string {
  if (!hits.length) return '(ничего не найдено)';
  return hits.map((h, i) => `[${i + 1}] ${h.metadata.file}${h.metadata.section ? ` › ${h.metadata.section}` : ''}\n${h.text}`).join('\n\n');
}

function summarizeDocs(s: IndexStats) {
  return {
    builtAt: s.builtAt,
    embeddingModel: s.embeddingModel,
    chunks: s.chunks,
    files: s.documents.filter((d) => d.group !== 'code').map((d) => ({ path: d.path, group: d.group, chunks: d.chunks })),
    code: {
      files: s.documents.filter((d) => d.group === 'code').length,
      chunks: s.documents.filter((d) => d.group === 'code').reduce((n, d) => n + d.chunks, 0),
    },
  };
}
