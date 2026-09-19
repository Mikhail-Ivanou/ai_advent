'use client';

import { FormEvent, useEffect, useState } from 'react';

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type TokenCounts = {
  requestTokens: number;
  historyTokens: number;
  responseTokens: number;
};

type ContextStrategy = 'none' | 'sliding-window' | 'summary' | 'sticky-facts' | 'branching';

type BranchSummary = { id: string; messageCount: number };

type ContextInfo = {
  strategy: ContextStrategy;
  keepLastN: number;
  recentMessageCount: number;
  summarizedMessageCount?: number;
  summary?: string;
  summaryUpdate?: { usage?: Usage; costByn?: number };
  facts?: Record<string, string>;
  factsUpdate?: { usage?: Usage; costByn?: number };
  activeBranchId?: string;
  branches?: BranchSummary[];
};

type LlmRequestLog = {
  label: string;
  /** The exact JSON body sent to the API for this call. */
  body: Record<string, unknown>;
};

// Memory model (Day 11): short-term is just the dialog above (Message[] /
// ContextInfo); working and long-term are tracked separately, see below.
type MemoryCategory = 'profile' | 'decision' | 'knowledge';

type MemoryEntry = {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  source: 'manual' | 'agent';
  createdAt: string;
  updatedAt: string;
};

type LongTermMemoryProposal = { category: MemoryCategory; key: string; value: string };

type MemoryUpdateInfo = {
  working: Record<string, string>;
  usedWorking: boolean;
  usedLongTerm: boolean;
  longTermAdded: LongTermMemoryProposal[];
  update?: { usage?: Usage; costByn?: number };
};

const MEMORY_CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: 'profile', label: 'Профиль' },
  { value: 'decision', label: 'Решения' },
  { value: 'knowledge', label: 'Знания' },
];

function memoryEntryKey(category: MemoryCategory, key: string): string {
  return `${category}:${key.trim().toLowerCase()}`;
}

// Personalization (Day 12): a profile is always explicit — created/edited by
// hand, never auto-extracted — and gets attached to every request for
// whichever chat has it selected, on top of the memory layers above.
type Profile = {
  id: string;
  name: string;
  style: string;
  format: string;
  constraints: string;
  createdAt: string;
  updatedAt: string;
};

type ProfileInput = Pick<Profile, 'name' | 'style' | 'format' | 'constraints'>;

function emptyProfileInput(): ProfileInput {
  return { name: '', style: '', format: '', constraints: '' };
}

// Task state machine (Day 13): planning → execution → validation → done,
// with validation allowed to bounce back to execution. Mirrors
// backend/src/llm/task-state.ts — kept in sync by hand since this is a small,
// stable table, not something worth a shared-package build step for.
type TaskStage = 'planning' | 'execution' | 'validation' | 'done';

const TASK_STAGES: TaskStage[] = ['planning', 'execution', 'validation', 'done'];

const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  planning: 'Планирование',
  execution: 'Выполнение',
  validation: 'Проверка',
  done: 'Готово',
};

const TASK_TRANSITIONS: Record<TaskStage, TaskStage[]> = {
  planning: ['execution'],
  execution: ['validation'],
  validation: ['execution', 'done'],
  done: [],
};

// Day 15: adjacency alone isn't enough — planning -> execution and
// validation -> done are each additionally gated behind an explicit
// approval, so the two example rules ("no implementation before an approved
// plan", "no final without validation") are enforced here too, not just on
// the backend.
function canTransitionTask(
  from: TaskStage,
  to: TaskStage,
  gates?: Pick<TaskState, 'planApproved' | 'validationPassed'>,
): boolean {
  if (from === to) return true;
  if (!TASK_TRANSITIONS[from].includes(to)) return false;
  if (from === 'planning' && to === 'execution') return gates ? gates.planApproved : true;
  if (from === 'validation' && to === 'done') return gates ? gates.validationPassed : true;
  return true;
}

type TaskState = {
  stage: TaskStage;
  goal: string;
  step: string;
  expectedAction: string;
  paused: boolean;
  planApproved: boolean;
  validationPassed: boolean;
  updatedAt: string;
};

type TaskInfo = {
  task: TaskState | null;
  updated: boolean;
  update?: { usage?: Usage; costByn?: number };
};

// Invariants (Day 14): hard constraints on the solution space — architecture,
// accepted decisions, stack limits, business rules — stored globally like
// profiles, never edited by the model itself, only by a person.
type InvariantCategory = 'architecture' | 'decision' | 'stack' | 'business-rule';

type Invariant = {
  id: string;
  category: InvariantCategory;
  title: string;
  rule: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type InvariantInput = Pick<Invariant, 'category' | 'title' | 'rule' | 'active'>;

function emptyInvariantInput(): InvariantInput {
  return { category: 'architecture', title: '', rule: '', active: true };
}

const INVARIANT_CATEGORIES: { value: InvariantCategory; label: string }[] = [
  { value: 'architecture', label: 'Архитектура' },
  { value: 'decision', label: 'Принятые решения' },
  { value: 'stack', label: 'Ограничения стека' },
  { value: 'business-rule', label: 'Бизнес-правила' },
];

const INVARIANT_CATEGORY_LABELS: Record<InvariantCategory, string> = Object.fromEntries(
  INVARIANT_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<InvariantCategory, string>;

type InvariantViolation = { id: string; title: string; explanation: string };

type InvariantCheckInfo = {
  used: boolean;
  checked: boolean;
  compliant?: boolean;
  violations?: InvariantViolation[];
  update?: { usage?: Usage; costByn?: number };
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    model: string;
    responseTimeMs: number;
    usage?: Usage;
    costByn?: number;
    tokens: TokenCounts;
    context?: ContextInfo;
    memory?: MemoryUpdateInfo;
    profile?: { id: string; name: string };
    task?: TaskInfo;
    invariants?: InvariantCheckInfo;
    requests: LlmRequestLog[];
  };
};

type Format = 'text' | 'json';
type ReasoningMode = 'direct' | 'step-by-step' | 'self-prompt' | 'expert-panel';

type ChatSettings = {
  format: Format;
  maxOutputTokens: string;
  stopSequence: string;
  reasoningMode: ReasoningMode;
  temperature: string;
  model: string;
  contextStrategy: ContextStrategy;
  keepLastN: string;
  useWorkingMemory: boolean;
  useLongTermMemory: boolean;
  updateMemory: boolean;
  profileId: string;
  updateTaskState: boolean;
  useInvariants: boolean;
  checkInvariants: boolean;
};

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
  settings: ChatSettings;
  // Branching only: known branches for this chat, which one is active, and a
  // per-branch cache of messages so switching back doesn't lose what's rich
  // (tokens/cost/etc.) for messages sent locally in this session.
  branches?: BranchSummary[];
  activeBranchId?: string;
  branchMessages?: Record<string, Message[]>;
};

const CONTEXT_STRATEGIES: { value: ContextStrategy; label: string }[] = [
  { value: 'none', label: 'Нет (полная история)' },
  { value: 'sliding-window', label: 'Sliding Window' },
  { value: 'summary', label: 'Summary (сжатие)' },
  { value: 'sticky-facts', label: 'Sticky Facts' },
  { value: 'branching', label: 'Branching (ветки)' },
];

const MODELS = [
  { value: 'deepseek-v4-flash', label: 'Слабая (deepseek-v4-flash)' },
  { value: 'deepseek-chat-v3', label: 'Средняя (deepseek-chat-v3)' },
  { value: 'kimi-k2.5', label: 'Средняя (kimi-k2.5)' },
  { value: 'deepseek-v4-pro', label: 'Сильная (deepseek-v4-pro)' },
  { value: 'gpt-3.5-turbo-instruct', label: 'Малое окно (gpt-3.5-turbo-instruct, 4k)' },
  { value: 'deepseek-r1-distill-llama-70b', label: 'Малое окно, ближе к DeepSeek (deepseek-r1-distill-llama-70b, 8k)' },
  { value: 'qwen-2.5-72b-instruct', label: 'Малое окно, быстрее (qwen-2.5-72b-instruct, 32k)' },
] as const;

const STORAGE_KEY = 'advent.chats';

function defaultSettings(): ChatSettings {
  return {
    format: 'text',
    maxOutputTokens: '',
    stopSequence: '',
    reasoningMode: 'direct',
    temperature: '1',
    model: MODELS[0].value,
    contextStrategy: 'none',
    keepLastN: '20',
    useWorkingMemory: true,
    useLongTermMemory: true,
    updateMemory: true,
    profileId: '',
    updateTaskState: true,
    useInvariants: true,
    checkInvariants: true,
  };
}

function createChat(): Chat {
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    createdAt: Date.now(),
    messages: [],
    settings: defaultSettings(),
  };
}

// Older persisted chats may not have a `settings` field yet — backfill defaults.
function normalizeChat(chat: Chat): Chat {
  return { ...chat, settings: { ...defaultSettings(), ...chat.settings } };
}

function chatTitle(chat: Chat): string {
  const firstUserMessage = chat.messages.find((m) => m.role === 'user');
  if (!firstUserMessage) return chat.title;
  return firstUserMessage.content.length > 30
    ? `${firstUserMessage.content.slice(0, 30)}…`
    : firstUserMessage.content;
}

export default function ChatPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Loading state and errors are keyed by chat id, so a request in one chat
  // never shows "Thinking…" or locks the input in another.
  const [loadingChatIds, setLoadingChatIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [input, setInput] = useState('');
  const [newBranchName, setNewBranchName] = useState('');

  // Long-term memory is global (shared across chats), unlike working memory
  // and the dialog itself — so it lives outside the per-chat `chats` state.
  const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
  const [latestAddedKeys, setLatestAddedKeys] = useState<Set<string>>(new Set());
  const [newMemory, setNewMemory] = useState<{ category: MemoryCategory; key: string; value: string }>({
    category: 'profile',
    key: '',
    value: '',
  });

  // Working memory, per chat id — fetched on first view of a chat and kept in
  // sync from each ask() response and from explicit clears.
  const [workingMemoryByChat, setWorkingMemoryByChat] = useState<Record<string, Record<string, string>>>({});

  // Collapsed by default — memory management is secondary to the task/profile
  // panels above it, so it shouldn't eat the sidebar's vertical space until
  // someone actually wants to look at it.
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);

  // Task state (Day 13), per chat id — same fetch-once-then-sync pattern as
  // working memory above.
  const [taskByChat, setTaskByChat] = useState<Record<string, TaskState | null>>({});

  const [logModalOpen, setLogModalOpen] = useState(false);

  // Profiles (Day 12) are global, like long-term memory — created once,
  // picked per chat via ChatSettings.profileId.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileInput>(emptyProfileInput());

  // Invariants (Day 14) are global too — a fixed rule set the assistant must
  // never propose violating, independent of any one chat.
  const [invariants, setInvariants] = useState<Invariant[]>([]);
  const [invariantModalOpen, setInvariantModalOpen] = useState(false);
  const [editingInvariantId, setEditingInvariantId] = useState<string | null>(null);
  const [invariantDraft, setInvariantDraft] = useState<InvariantInput>(emptyInvariantInput());

  // Load persisted chats on mount, or seed with a single empty chat.
  useEffect(() => {
    let loaded: Chat[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch {
      loaded = [];
    }
    if (loaded.length === 0) loaded = [createChat()];
    loaded = loaded.map(normalizeChat);
    setChats(loaded);
    setActiveChatId(loaded[0].id);
    setHydrated(true);
  }, []);

  // Persist chats whenever they change.
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }, [chats, hydrated]);

  async function refreshLongTermMemory() {
    try {
      const response = await fetch('/api/backend/memory');
      if (!response.ok) return;
      const data: { entries: MemoryEntry[] } = await response.json();
      setLongTermEntries(data.entries);
    } catch {
      // Best-effort — the panel just stays at whatever it last had.
    }
  }

  // Long-term memory is global, so it's loaded once, not per chat.
  useEffect(() => {
    if (!hydrated) return;
    refreshLongTermMemory();
  }, [hydrated]);

  async function refreshProfiles() {
    try {
      const response = await fetch('/api/backend/profiles');
      if (!response.ok) return;
      const data: { profiles: Profile[] } = await response.json();
      setProfiles(data.profiles);
    } catch {
      // Best-effort — the picker just stays at whatever it last had.
    }
  }

  // Profiles are global too, loaded once.
  useEffect(() => {
    if (!hydrated) return;
    refreshProfiles();
  }, [hydrated]);

  async function refreshInvariants() {
    try {
      const response = await fetch('/api/backend/invariants');
      if (!response.ok) return;
      const data: { invariants: Invariant[] } = await response.json();
      setInvariants(data.invariants);
    } catch {
      // Best-effort — the panel just stays at whatever it last had.
    }
  }

  // Invariants are global too, loaded once.
  useEffect(() => {
    if (!hydrated) return;
    refreshInvariants();
  }, [hydrated]);

  // Working memory is per chat — fetch it the first time a chat is viewed
  // (e.g. after a page reload) rather than on every render.
  useEffect(() => {
    if (!hydrated || !activeChatId || activeChatId in workingMemoryByChat) return;
    fetch(`/api/backend/agents/${activeChatId}/memory/working`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { working: Record<string, string> } | null) => {
        if (data) setWorkingMemoryByChat((prev) => ({ ...prev, [activeChatId]: data.working }));
      })
      .catch(() => {});
  }, [hydrated, activeChatId, workingMemoryByChat]);

  useEffect(() => {
    if (!hydrated || !activeChatId || activeChatId in taskByChat) return;
    fetch(`/api/backend/agents/${activeChatId}/task`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { task: TaskState | null } | null) => {
        if (data) setTaskByChat((prev) => ({ ...prev, [activeChatId]: data.task }));
      })
      .catch(() => {});
  }, [hydrated, activeChatId, taskByChat]);

  useEffect(() => {
    if (!logModalOpen && !profileModalOpen && !invariantModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLogModalOpen(false);
      setProfileModalOpen(false);
      setInvariantModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logModalOpen, profileModalOpen, invariantModalOpen]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const isActiveLoading = activeChatId ? loadingChatIds.has(activeChatId) : false;
  const activeError = activeChatId ? (errors[activeChatId] ?? null) : null;

  const chatTotals = (activeChat?.messages ?? []).reduce(
    (totals, message) => {
      if (!message.meta) return totals;
      return {
        apiTokens: totals.apiTokens + (message.meta.usage?.totalTokens ?? 0),
        costByn: totals.costByn + (message.meta.costByn ?? 0),
      };
    },
    { apiTokens: 0, costByn: 0 },
  );

  const latestContext = [...(activeChat?.messages ?? [])].reverse().find((m) => m.meta?.context)?.meta?.context;
  const latestRequests = [...(activeChat?.messages ?? [])].reverse().find((m) => m.meta?.requests)?.meta?.requests;

  function newChat() {
    const chat = createChat();
    setChats((prev) => [chat, ...prev]);
    setActiveChatId(chat.id);
  }

  function deleteChat(id: string) {
    setChats((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      if (remaining.length > 0) {
        if (activeChatId === id) setActiveChatId(remaining[0].id);
        return remaining;
      }
      const fresh = createChat();
      setActiveChatId(fresh.id);
      return [fresh];
    });
    setLoadingChatIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // Best-effort: drop the agent's persisted history server-side too.
    fetch(`/api/backend/agents/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  function switchChat(id: string) {
    setActiveChatId(id);
  }

  function updateMessages(chatId: string, updater: (messages: Message[]) => Message[]) {
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: updater(c.messages) } : c)));
  }

  function updateSettings(chatId: string, patch: Partial<ChatSettings>) {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, settings: { ...c.settings, ...patch } } : c)),
    );
  }

  function updateChat(chatId: string, patch: Partial<Chat>) {
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, ...patch } : c)));
  }

  function setChatLoading(chatId: string, isLoading: boolean) {
    setLoadingChatIds((prev) => {
      const next = new Set(prev);
      if (isLoading) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }

  function setChatError(chatId: string, message: string | null) {
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[chatId] = message;
      else delete next[chatId];
      return next;
    });
  }

  async function refreshBranches(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/branches`);
      if (!response.ok) return;
      const data: { branches: BranchSummary[]; activeBranchId: string } = await response.json();
      updateChat(chatId, { branches: data.branches, activeBranchId: data.activeBranchId });
    } catch {
      // Best-effort — branch list is a convenience, not required for chatting.
    }
  }

  async function forkBranch(chatId: string) {
    const name = newBranchName.trim();
    if (!name) return;
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;

    try {
      const createResponse = await fetch(`/api/backend/agents/${chatId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!createResponse.ok) {
        setChatError(chatId, `Could not create branch: ${createResponse.status} ${await createResponse.text()}`);
        return;
      }
      await fetch(`/api/backend/agents/${chatId}/branches/${name}/switch`, { method: 'POST' });

      // The new branch is an exact copy of what's on screen right now — cache
      // it immediately instead of round-tripping for messages we already have.
      const cached = { ...(chat.branchMessages ?? {}), [name]: chat.messages };
      updateChat(chatId, { branchMessages: cached, activeBranchId: name });
      setNewBranchName('');
      await refreshBranches(chatId);
    } catch (err) {
      setChatError(chatId, err instanceof Error ? err.message : 'Could not create branch');
    }
  }

  async function switchToBranch(chatId: string, branchId: string) {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || branchId === chat.activeBranchId) return;

    try {
      const response = await fetch(`/api/backend/agents/${chatId}/branches/${branchId}/switch`, { method: 'POST' });
      if (!response.ok) {
        setChatError(chatId, `Could not switch branch: ${response.status} ${await response.text()}`);
        return;
      }

      const cached = chat.branchMessages?.[branchId];
      if (cached) {
        updateChat(chatId, { activeBranchId: branchId, messages: cached });
        return;
      }

      // Not cached locally (e.g. after a page reload) — fetch the branch's raw
      // messages. They won't carry per-message tokens/cost, only role+content.
      const messagesResponse = await fetch(`/api/backend/agents/${chatId}/messages`);
      const data: { messages: { role: 'user' | 'assistant'; content: string }[] } = await messagesResponse.json();
      const basicMessages: Message[] = data.messages.map((m) => ({ role: m.role, content: m.content }));
      updateChat(chatId, {
        activeBranchId: branchId,
        messages: basicMessages,
        branchMessages: { ...(chat.branchMessages ?? {}), [branchId]: basicMessages },
      });
    } catch (err) {
      setChatError(chatId, err instanceof Error ? err.message : 'Could not switch branch');
    }
  }

  async function clearWorkingMemory(chatId: string) {
    setWorkingMemoryByChat((prev) => ({ ...prev, [chatId]: {} }));
    try {
      await fetch(`/api/backend/agents/${chatId}/memory/working`, { method: 'DELETE' });
    } catch {
      // Best-effort — worst case it comes back on the next turn's response.
    }
  }

  async function refreshTaskState(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task`);
      if (!response.ok) return;
      const data: { task: TaskState | null } = await response.json();
      setTaskByChat((prev) => ({ ...prev, [chatId]: data.task }));
    } catch {
      // Best-effort — the panel just stays at whatever it last had.
    }
  }

  async function pauseTask(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task/pause`, { method: 'POST' });
      if (response.ok) setTaskByChat((prev) => ({ ...prev, [chatId]: prev[chatId] ? { ...prev[chatId]!, paused: true } : null }));
    } catch {
      // Best-effort — a stale panel is the worst case, not a broken one.
    }
  }

  async function resumeTask(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task/resume`, { method: 'POST' });
      if (response.ok) setTaskByChat((prev) => ({ ...prev, [chatId]: prev[chatId] ? { ...prev[chatId]!, paused: false } : null }));
    } catch {
      // Best-effort.
    }
  }

  async function setTaskStage(chatId: string, stage: TaskStage) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (response.ok) await refreshTaskState(chatId);
    } catch {
      // Best-effort.
    }
  }

  async function resetTask(chatId: string) {
    setTaskByChat((prev) => ({ ...prev, [chatId]: null }));
    try {
      await fetch(`/api/backend/agents/${chatId}/task`, { method: 'DELETE' });
    } catch {
      // Best-effort — a stale refresh will bring the old state back if the reset failed.
    }
  }

  async function approvePlan(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task/approve-plan`, { method: 'POST' });
      if (response.ok) await refreshTaskState(chatId);
    } catch {
      // Best-effort.
    }
  }

  async function approveValidation(chatId: string) {
    try {
      const response = await fetch(`/api/backend/agents/${chatId}/task/approve-validation`, { method: 'POST' });
      if (response.ok) await refreshTaskState(chatId);
    } catch {
      // Best-effort.
    }
  }

  async function addLongTermEntry(event: FormEvent) {
    event.preventDefault();
    const key = newMemory.key.trim();
    const value = newMemory.value.trim();
    if (!key || !value) return;
    try {
      const response = await fetch('/api/backend/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: newMemory.category, key, value }),
      });
      if (response.ok) {
        setNewMemory({ category: newMemory.category, key: '', value: '' });
        await refreshLongTermMemory();
      }
    } catch {
      // Best-effort manual add — leave the form filled in so the user can retry.
    }
  }

  async function deleteLongTermEntry(id: string) {
    setLongTermEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch(`/api/backend/memory/${id}`, { method: 'DELETE' });
    } catch {
      // Best-effort — a stale refresh will bring it back if the delete failed.
    }
  }

  function startNewProfile() {
    setEditingProfileId(null);
    setProfileDraft(emptyProfileInput());
  }

  function startEditingProfile(profile: Profile) {
    setEditingProfileId(profile.id);
    setProfileDraft({
      name: profile.name,
      style: profile.style,
      format: profile.format,
      constraints: profile.constraints,
    });
  }

  async function saveProfileDraft(event: FormEvent) {
    event.preventDefault();
    const name = profileDraft.name.trim();
    if (!name) return;
    const payload = { ...profileDraft, name };

    try {
      const response = editingProfileId
        ? await fetch(`/api/backend/profiles/${editingProfileId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/backend/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      if (response.ok) {
        startNewProfile();
        await refreshProfiles();
      }
    } catch {
      // Best-effort — leave the form filled in so the user can retry.
    }
  }

  async function deleteProfile(id: string) {
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    if (editingProfileId === id) startNewProfile();
    // Any chat that had this profile selected falls back to "no profile"
    // rather than silently keeping a dangling id.
    setChats((prev) =>
      prev.map((c) => (c.settings.profileId === id ? { ...c, settings: { ...c.settings, profileId: '' } } : c)),
    );
    try {
      await fetch(`/api/backend/profiles/${id}`, { method: 'DELETE' });
    } catch {
      // Best-effort — a stale refresh will bring it back if the delete failed.
    }
  }

  function startNewInvariant() {
    setEditingInvariantId(null);
    setInvariantDraft(emptyInvariantInput());
  }

  function startEditingInvariant(invariant: Invariant) {
    setEditingInvariantId(invariant.id);
    setInvariantDraft({
      category: invariant.category,
      title: invariant.title,
      rule: invariant.rule,
      active: invariant.active,
    });
  }

  async function saveInvariantDraft(event: FormEvent) {
    event.preventDefault();
    const title = invariantDraft.title.trim();
    const rule = invariantDraft.rule.trim();
    if (!title || !rule) return;
    const payload = { ...invariantDraft, title, rule };

    try {
      const response = editingInvariantId
        ? await fetch(`/api/backend/invariants/${editingInvariantId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/backend/invariants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      if (response.ok) {
        startNewInvariant();
        await refreshInvariants();
      }
    } catch {
      // Best-effort — leave the form filled in so the user can retry.
    }
  }

  async function toggleInvariantActive(invariant: Invariant) {
    setInvariants((prev) => prev.map((i) => (i.id === invariant.id ? { ...i, active: !i.active } : i)));
    try {
      await fetch(`/api/backend/invariants/${invariant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !invariant.active }),
      });
    } catch {
      // Best-effort — a stale refresh will bring the true state back if this failed.
    }
  }

  async function deleteInvariant(id: string) {
    setInvariants((prev) => prev.filter((i) => i.id !== id));
    if (editingInvariantId === id) startNewInvariant();
    try {
      await fetch(`/api/backend/invariants/${id}`, { method: 'DELETE' });
    } catch {
      // Best-effort — a stale refresh will bring it back if the delete failed.
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const chatId = activeChatId;
    const prompt = input.trim();
    if (!prompt || !chatId || loadingChatIds.has(chatId)) return;

    const chat = chats.find((c) => c.id === chatId);
    const settings = chat?.settings ?? defaultSettings();
    const activeBranchId = chat?.activeBranchId;

    updateMessages(chatId, (messages) => [...messages, { role: 'user', content: prompt }]);
    setInput('');
    setChatLoading(chatId, true);
    setChatError(chatId, null);

    const parsedMaxTokens = parseInt(settings.maxOutputTokens, 10);
    const parsedKeepLastN = parseInt(settings.keepLastN, 10);

    try {
      const response = await fetch(`/api/backend/agents/${chatId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          format: settings.format,
          maxOutputTokens: Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : undefined,
          stopSequence: settings.stopSequence.trim() || undefined,
          reasoningMode: settings.reasoningMode,
          temperature: parseFloat(settings.temperature),
          model: settings.model,
          context: {
            strategy: settings.contextStrategy,
            keepLastN: Number.isFinite(parsedKeepLastN) && parsedKeepLastN >= 0 ? parsedKeepLastN : 20,
          },
          memory: {
            useWorking: settings.useWorkingMemory,
            useLongTerm: settings.useLongTermMemory,
            update: settings.updateMemory,
          },
          profileId: settings.profileId || undefined,
          task: {
            update: settings.updateTaskState,
          },
          invariants: {
            use: settings.useInvariants,
            check: settings.checkInvariants,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status} ${await response.text()}`);
      }

      const data: {
        answer: string;
        model: string;
        responseTimeMs: number;
        usage?: Usage;
        costByn?: number;
        tokens: TokenCounts;
        context?: ContextInfo;
        memory?: MemoryUpdateInfo;
        profile?: { id: string; name: string };
        task?: TaskInfo;
        invariants?: InvariantCheckInfo;
        requests: LlmRequestLog[];
      } = await response.json();

      updateMessages(chatId, (messages) => {
        const next: Message[] = [
          ...messages,
          {
            role: 'assistant',
            content: data.answer,
            meta: {
              model: data.model,
              responseTimeMs: data.responseTimeMs,
              usage: data.usage,
              costByn: data.costByn,
              tokens: data.tokens,
              context: data.context,
              memory: data.memory,
              profile: data.profile,
              task: data.task,
              invariants: data.invariants,
              requests: data.requests,
            },
          },
        ];
        // Keep the branching cache in sync so switching away and back doesn't
        // lose the message we just sent.
        if (activeBranchId) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === chatId
                ? { ...c, branchMessages: { ...(c.branchMessages ?? {}), [activeBranchId]: next } }
                : c,
            ),
          );
        }
        return next;
      });

      if (data.memory) {
        setWorkingMemoryByChat((prev) => ({ ...prev, [chatId]: data.memory!.working }));
        if (data.memory.longTermAdded.length > 0) {
          setLatestAddedKeys(new Set(data.memory.longTermAdded.map((p) => memoryEntryKey(p.category, p.key))));
          refreshLongTermMemory();
        }
      }

      if (data.task) {
        setTaskByChat((prev) => ({ ...prev, [chatId]: data.task!.task }));
      }

      if (settings.contextStrategy === 'branching') {
        refreshBranches(chatId);
      }
    } catch (err) {
      setChatError(chatId, err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setChatLoading(chatId, false);
    }
  }

  if (!hydrated || !activeChat) {
    return null;
  }

  const settings = activeChat.settings;
  const isBranching = settings.contextStrategy === 'branching';
  const currentWorkingMemory = workingMemoryByChat[activeChat.id] ?? {};
  const currentTask = taskByChat[activeChat.id] ?? null;

  return (
    <main className="mx-auto flex h-screen max-w-[100rem] gap-4 overflow-hidden bg-paper px-6 py-10 text-ink">
      <aside className="flex w-56 shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={newChat}
          className="rounded-md bg-pine px-3 py-2 text-sm text-white hover:opacity-90"
        >
          + Новый чат
        </button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {chats.map((chat) => (
            <div
              key={chat.id}
              onClick={() => switchChat(chat.id)}
              className={`group flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
                chat.id === activeChatId
                  ? 'border-pine bg-white font-medium'
                  : 'border-black/10 bg-white/50 hover:bg-white'
              }`}
            >
              <span className="truncate">
                {chatTitle(chat)}
                {loadingChatIds.has(chat.id) && <span className="ml-1 text-pine">…</span>}
              </span>
              <button
                type="button"
                title="Удалить чат"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteChat(chat.id);
                }}
                className="shrink-0 rounded px-1 text-[#5c5c5c] opacity-0 hover:bg-black/5 hover:text-red-600 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="shrink-0 flex items-center justify-between">
          <h1 className="truncate text-2xl font-medium">{chatTitle(activeChat)}</h1>
        </div>

        <div className="shrink-0 flex flex-wrap gap-4 rounded-lg border border-black/10 bg-white p-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Reasoning mode</span>
            <select
              value={settings.reasoningMode}
              onChange={(event) =>
                updateSettings(activeChat.id, { reasoningMode: event.target.value as ReasoningMode })
              }
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="direct">Direct answer</option>
              <option value="step-by-step">Step by step</option>
              <option value="self-prompt">Self-authored prompt</option>
              <option value="expert-panel">Expert panel</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Model</span>
            <select
              value={settings.model}
              onChange={(event) => updateSettings(activeChat.id, { model: event.target.value })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Temperature</span>
            <select
              value={settings.temperature}
              onChange={(event) => updateSettings(activeChat.id, { temperature: event.target.value })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="0">0</option>
              <option value="0.7">0.7</option>
              <option value="1">1 (default)</option>
              <option value="1.2">1.2</option>
              <option value="1.7">1.7</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Response format</span>
            <select
              value={settings.format}
              onChange={(event) => updateSettings(activeChat.id, { format: event.target.value as Format })}
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              <option value="text">Plain text</option>
              <option value="json">JSON</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Max output tokens</span>
            <input
              type="number"
              min={1}
              value={settings.maxOutputTokens}
              onChange={(event) => updateSettings(activeChat.id, { maxOutputTokens: event.target.value })}
              placeholder="No limit"
              className="w-32 rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            />
          </label>

          <label className="flex flex-1 min-w-[12rem] flex-col gap-1">
            <span className="text-xs text-pine">Stop sequence / instruction</span>
            <input
              type="text"
              value={settings.stopSequence}
              onChange={(event) => updateSettings(activeChat.id, { stopSequence: event.target.value })}
              placeholder='e.g. "###" or "stop after the summary"'
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Стратегия контекста</span>
            <select
              value={settings.contextStrategy}
              onChange={(event) =>
                updateSettings(activeChat.id, { contextStrategy: event.target.value as ContextStrategy })
              }
              className="rounded-md border border-black/10 px-2 py-1"
              disabled={isActiveLoading}
            >
              {CONTEXT_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-pine">Хранить как есть, N сообщ.</span>
            <input
              type="number"
              min={0}
              value={settings.keepLastN}
              onChange={(event) => updateSettings(activeChat.id, { keepLastN: event.target.value })}
              className="w-32 rounded-md border border-black/10 px-2 py-1"
              disabled={
                isActiveLoading ||
                settings.contextStrategy === 'none' ||
                settings.contextStrategy === 'branching'
              }
            />
          </label>
        </div>

        {isBranching && (
          <div className="shrink-0 flex flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-white p-3 text-sm">
            <span className="text-xs text-pine">Ветки:</span>
            {(activeChat.branches ?? [{ id: 'main', messageCount: activeChat.messages.length }]).map((branch) => (
              <button
                key={branch.id}
                type="button"
                onClick={() => switchToBranch(activeChat.id, branch.id)}
                disabled={isActiveLoading}
                className={`rounded-md border px-2 py-1 text-xs ${
                  (activeChat.activeBranchId ?? 'main') === branch.id
                    ? 'border-pine bg-paper font-medium'
                    : 'border-black/10 hover:bg-paper'
                }`}
              >
                {branch.id} ({branch.messageCount})
              </button>
            ))}
            <input
              type="text"
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              placeholder="Имя новой ветки"
              className="w-40 rounded-md border border-black/10 px-2 py-1 text-xs"
              disabled={isActiveLoading}
            />
            <button
              type="button"
              onClick={() => forkBranch(activeChat.id)}
              disabled={isActiveLoading || !newBranchName.trim()}
              className="rounded-md bg-pine px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              Ветвиться отсюда
            </button>
          </div>
        )}

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-black/10 bg-white p-4 text-sm">
          {activeChat.messages.length === 0 && (
            <p className="text-[#5c5c5c]">Ask the LLM something to get started.</p>
          )}
          {activeChat.messages.map((message, index) => (
            <div
              key={index}
              className={message.role === 'user' ? 'self-end text-right' : 'self-start text-left'}
            >
              <span className="mb-1 block text-xs text-pine">
                {message.role === 'user' ? 'You' : 'Assistant'}
              </span>
              <p className="inline-block whitespace-pre-wrap rounded-lg bg-paper px-3 py-2">
                {message.content}
              </p>
              {message.meta && (
                <>
                  <p className="mt-1 text-xs text-[#5c5c5c]">
                    {message.meta.model} · {(message.meta.responseTimeMs / 1000).toFixed(1)}с
                    {message.meta.usage && <> · {message.meta.usage.totalTokens} токенов</>}
                    {message.meta.costByn !== undefined && (
                      <> · {message.meta.costByn.toFixed(5)} BYN</>
                    )}
                  </p>
                  <p className="text-xs text-[#5c5c5c]">
                    запрос: {message.meta.tokens.requestTokens} · ответ: {message.meta.tokens.responseTokens} токенов
                  </p>
                  {message.meta.profile && (
                    <p className="text-xs text-[#5c5c5c]">Профиль: {message.meta.profile.name}</p>
                  )}
                  {message.meta.task?.updated && message.meta.task.task && (
                    <p className="text-xs text-[#5c5c5c]">
                      Задача: {TASK_STAGE_LABELS[message.meta.task.task.stage]} — {message.meta.task.task.step}
                    </p>
                  )}
                  {message.meta.invariants?.checked && (
                    <p
                      className={`text-xs ${
                        message.meta.invariants.compliant ? 'text-[#5c5c5c]' : 'font-medium text-red-600'
                      }`}
                      title={message.meta.invariants.violations?.map((v) => `${v.title}: ${v.explanation}`).join('\n')}
                    >
                      {message.meta.invariants.compliant
                        ? '✓ Соответствует инвариантам'
                        : `⚠ Нарушение: ${message.meta.invariants.violations?.map((v) => v.title).join(', ')}`}
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
          {isActiveLoading && <p className="text-[#5c5c5c]">Thinking…</p>}
        </div>

        {activeChat.messages.length > 0 && (
          <p className="shrink-0 text-xs text-[#5c5c5c]">
            Итого по чату: {chatTotals.apiTokens} токенов (по данным API) · {chatTotals.costByn.toFixed(5)} BYN
          </p>
        )}

        {settings.contextStrategy === 'sliding-window' && latestContext && (
          <p className="shrink-0 text-xs text-[#5c5c5c]">
            Sliding Window: в контекст отправлено последних {latestContext.recentMessageCount} сообщ. (окно N=
            {latestContext.keepLastN})
          </p>
        )}

        {settings.contextStrategy === 'summary' && latestContext && (
          <p className="shrink-0 text-xs text-[#5c5c5c]">
            Summary: как есть — {latestContext.recentMessageCount} сообщ. · обобщено —{' '}
            {latestContext.summarizedMessageCount} сообщ.
            {latestContext.summary &&
              ` · summary: ${latestContext.summary.slice(0, 120)}${latestContext.summary.length > 120 ? '…' : ''}`}
          </p>
        )}

        {settings.contextStrategy === 'sticky-facts' && latestContext?.facts && (
          <div className="shrink-0 rounded-lg border border-black/10 bg-white p-2 text-xs text-[#5c5c5c]">
            <span className="font-medium text-pine">Facts: </span>
            {Object.keys(latestContext.facts).length === 0
              ? 'пока ничего не известно'
              : Object.entries(latestContext.facts)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(' · ')}
          </div>
        )}

        {activeError && <p className="shrink-0 text-sm text-red-600">{activeError}</p>}

        <form onSubmit={sendMessage} className="shrink-0 flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a message…"
            className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-pine"
            disabled={isActiveLoading}
          />
          <button
            type="submit"
            disabled={isActiveLoading || !input.trim()}
            className="rounded-lg bg-pine px-4 py-2 text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>

      <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-hidden">
        <section className="shrink-0 rounded-lg border border-black/10 bg-white p-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-medium text-pine">Профиль пользователя</h2>
            <button
              type="button"
              onClick={() => {
                startNewProfile();
                setProfileModalOpen(true);
              }}
              className="text-[11px] text-[#5c5c5c] hover:text-pine"
            >
              Управлять
            </button>
          </div>
          <select
            value={settings.profileId}
            onChange={(event) => updateSettings(activeChat.id, { profileId: event.target.value })}
            className="w-full rounded-md border border-black/10 px-2 py-1"
          >
            <option value="">— без профиля —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {settings.profileId && (
            <p className="mt-1 text-[#5c5c5c]">
              Применяется автоматически ко всем сообщениям в этом чате, пока не изменён или не снят.
            </p>
          )}
        </section>

        <section className="shrink-0 rounded-lg border border-black/10 bg-white p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-pine">Задача (конечный автомат)</h2>
            <label className="flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={settings.updateTaskState}
                onChange={(event) => updateSettings(activeChat.id, { updateTaskState: event.target.checked })}
              />
              авто
            </label>
          </div>

          {!currentTask ? (
            <p className="text-[#5c5c5c]">
              Активной задачи нет — появится сама, как только начнётся многошаговая работа.
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {TASK_STAGES.map((stage) => (
                  <button
                    key={stage}
                    type="button"
                    onClick={() => setTaskStage(activeChat.id, stage)}
                    disabled={stage !== currentTask.stage && !canTransitionTask(currentTask.stage, stage, currentTask)}
                    title={
                      currentTask.stage === 'planning' && stage === 'execution' && !currentTask.planApproved
                        ? 'Нельзя перейти к выполнению — план ещё не утверждён'
                        : currentTask.stage === 'validation' && stage === 'done' && !currentTask.validationPassed
                          ? 'Нельзя завершить — валидация ещё не пройдена'
                          : undefined
                    }
                    className={`rounded-md border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                      stage === currentTask.stage ? 'border-pine bg-pine text-white' : 'border-black/10 hover:bg-paper'
                    }`}
                  >
                    {TASK_STAGE_LABELS[stage]}
                  </button>
                ))}
              </div>
              <p>
                <span className="font-medium text-pine">Цель:</span> {currentTask.goal}
              </p>
              <p>
                <span className="font-medium text-pine">Шаг:</span> {currentTask.step}
              </p>
              <p>
                <span className="font-medium text-pine">Ожидается:</span> {currentTask.expectedAction}
              </p>
              <p className={currentTask.planApproved ? 'text-[#5c5c5c]' : 'font-medium text-amber-600'}>
                План утверждён: {currentTask.planApproved ? 'да' : 'нет'}
              </p>
              <p className={currentTask.validationPassed ? 'text-[#5c5c5c]' : 'font-medium text-amber-600'}>
                Валидация пройдена: {currentTask.validationPassed ? 'да' : 'нет'}
              </p>
              {currentTask.paused && <p className="mt-1 font-medium text-amber-600">⏸ Приостановлено</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {currentTask.paused ? (
                  <button
                    type="button"
                    onClick={() => resumeTask(activeChat.id)}
                    className="rounded-md bg-pine px-3 py-1 text-white"
                  >
                    Продолжить
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => pauseTask(activeChat.id)}
                    className="rounded-md border border-black/10 px-3 py-1 hover:bg-paper"
                  >
                    Пауза
                  </button>
                )}
                {currentTask.stage === 'planning' && !currentTask.planApproved && (
                  <button
                    type="button"
                    onClick={() => approvePlan(activeChat.id)}
                    className="rounded-md border border-pine px-3 py-1 text-pine hover:bg-paper"
                  >
                    Утвердить план
                  </button>
                )}
                {currentTask.stage === 'validation' && !currentTask.validationPassed && (
                  <button
                    type="button"
                    onClick={() => approveValidation(activeChat.id)}
                    className="rounded-md border border-pine px-3 py-1 text-pine hover:bg-paper"
                  >
                    Подтвердить валидацию
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => resetTask(activeChat.id)}
                  className="rounded-md border border-black/10 px-3 py-1 text-[#5c5c5c] hover:bg-paper hover:text-red-600"
                >
                  Сбросить
                </button>
              </div>
            </>
          )}
        </section>

        <section className="shrink-0 rounded-lg border border-black/10 bg-white p-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-medium text-pine">Инварианты</h2>
            <button
              type="button"
              onClick={() => {
                startNewInvariant();
                setInvariantModalOpen(true);
              }}
              className="text-[11px] text-[#5c5c5c] hover:text-pine"
            >
              Управлять
            </button>
          </div>
          <div className="mb-1 flex flex-wrap gap-3">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.useInvariants}
                onChange={(event) => updateSettings(activeChat.id, { useInvariants: event.target.checked })}
              />
              учитывать
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.checkInvariants}
                onChange={(event) => updateSettings(activeChat.id, { checkInvariants: event.target.checked })}
              />
              проверять соответствие
            </label>
          </div>
          <p className="text-[#5c5c5c]">
            Активно: {invariants.filter((i) => i.active).length} из {invariants.length}
          </p>
        </section>

        <section
          className={`rounded-lg border border-black/10 bg-white ${
            memoryPanelOpen ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'shrink-0'
          }`}
        >
          <button
            type="button"
            onClick={() => setMemoryPanelOpen((open) => !open)}
            className="flex w-full shrink-0 items-center justify-between p-3 text-left"
          >
            <h2 className="text-sm font-medium text-pine">Память агента</h2>
            <span className="text-[#5c5c5c]">{memoryPanelOpen ? '▾ свернуть' : '▸ развернуть'}</span>
          </button>

          {memoryPanelOpen && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-black/10 p-3">
              <div className="shrink-0 flex flex-wrap gap-3 rounded-lg border border-black/10 bg-paper p-2 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={settings.useWorkingMemory}
                    onChange={(event) => updateSettings(activeChat.id, { useWorkingMemory: event.target.checked })}
                  />
                  рабочая
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={settings.useLongTermMemory}
                    onChange={(event) => updateSettings(activeChat.id, { useLongTermMemory: event.target.checked })}
                  />
                  долговременная
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={settings.updateMemory}
                    onChange={(event) => updateSettings(activeChat.id, { updateMemory: event.target.checked })}
                  />
                  обновлять
                </label>
              </div>

              <section className="shrink-0 rounded-lg border border-black/10 p-3 text-xs">
                <h3 className="mb-1 font-medium text-pine">Кратковременная (текущий диалог)</h3>
                <p className="text-[#5c5c5c]">
                  Сообщений в чате: {activeChat.messages.length}
                  {latestContext && (
                    <> · отправлено в контексте последнего запроса: {latestContext.recentMessageCount}</>
                  )}
                </p>
              </section>

              <section className="shrink-0 rounded-lg border border-black/10 p-3 text-xs">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-medium text-pine">Рабочая (текущая задача)</h3>
                  <button
                    type="button"
                    onClick={() => clearWorkingMemory(activeChat.id)}
                    className="text-[11px] text-[#5c5c5c] hover:text-red-600"
                  >
                    Очистить
                  </button>
                </div>
                {Object.keys(currentWorkingMemory).length === 0 ? (
                  <p className="text-[#5c5c5c]">Пока пусто.</p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {Object.entries(currentWorkingMemory).map(([key, value]) => (
                      <li key={key}>
                        <span className="font-mono text-pine">{key}:</span> {value}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="shrink-0 rounded-lg border border-black/10 p-3 text-xs">
                <h3 className="mb-2 font-medium text-pine">Долговременная (профиль, решения, знания)</h3>
                {MEMORY_CATEGORIES.map(({ value: category, label }) => {
                  const items = longTermEntries.filter((e) => e.category === category);
                  return (
                    <div key={category} className="mb-2">
                      <p className="mb-0.5 font-medium text-[#5c5c5c]">{label}</p>
                      {items.length === 0 && <p className="text-[#5c5c5c]">—</p>}
                      <ul className="flex flex-col gap-0.5">
                        {items.map((entry) => (
                          <li
                            key={entry.id}
                            className={`flex items-start justify-between gap-2 rounded px-1 ${
                              latestAddedKeys.has(memoryEntryKey(entry.category, entry.key)) ? 'bg-pine/10' : ''
                            }`}
                          >
                            <span>
                              <span className="font-mono text-pine">{entry.key}:</span> {entry.value}
                            </span>
                            <button
                              type="button"
                              title="Удалить"
                              onClick={() => deleteLongTermEntry(entry.id)}
                              className="shrink-0 text-[#5c5c5c] hover:text-red-600"
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}

                <form onSubmit={addLongTermEntry} className="mt-2 flex flex-col gap-1 border-t border-black/10 pt-2">
                  <select
                    value={newMemory.category}
                    onChange={(event) =>
                      setNewMemory({ ...newMemory, category: event.target.value as MemoryCategory })
                    }
                    className="rounded-md border border-black/10 px-2 py-1"
                  >
                    {MEMORY_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newMemory.key}
                    onChange={(event) => setNewMemory({ ...newMemory, key: event.target.value })}
                    placeholder="ключ (например: имя)"
                    className="rounded-md border border-black/10 px-2 py-1"
                  />
                  <input
                    type="text"
                    value={newMemory.value}
                    onChange={(event) => setNewMemory({ ...newMemory, value: event.target.value })}
                    placeholder="значение"
                    className="rounded-md border border-black/10 px-2 py-1"
                  />
                  <button
                    type="submit"
                    disabled={!newMemory.key.trim() || !newMemory.value.trim()}
                    className="rounded-md bg-pine px-3 py-1 text-white disabled:opacity-50"
                  >
                    Добавить вручную
                  </button>
                </form>
              </section>
            </div>
          )}
        </section>
      </aside>

      <button
        type="button"
        onClick={() => setLogModalOpen(true)}
        className="fixed bottom-6 right-6 z-10 rounded-full bg-pine px-4 py-2 text-sm text-white shadow-lg hover:opacity-90"
      >
        Лог запросов{latestRequests && latestRequests.length > 1 ? ` (${latestRequests.length})` : ''}
      </button>

      {logModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setLogModalOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-lg bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="text-sm font-medium text-pine">
                Фактический запрос {latestRequests && latestRequests.length > 1 ? `(${latestRequests.length})` : ''}
              </h2>
              <button
                type="button"
                onClick={() => setLogModalOpen(false)}
                className="rounded px-2 text-[#5c5c5c] hover:bg-black/5 hover:text-ink"
              >
                ×
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto text-xs">
              {!latestRequests && <p className="text-[#5c5c5c]">Здесь появится последний запрос к модели.</p>}
              {latestRequests?.map((req, reqIndex) => (
                <div key={reqIndex} className="rounded-md border border-black/10 p-2">
                  <p className="mb-1 font-mono font-semibold text-pine">{req.label}</p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink">
                    {JSON.stringify(req.body, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {profileModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setProfileModalOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 overflow-hidden rounded-lg bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="text-sm font-medium text-pine">Профили пользователя</h2>
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="rounded px-2 text-[#5c5c5c] hover:bg-black/5 hover:text-ink"
              >
                ×
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto text-xs">
              <ul className="flex flex-col gap-1">
                {profiles.map((p) => (
                  <li
                    key={p.id}
                    className={`flex items-start justify-between gap-2 rounded-md border p-2 ${
                      editingProfileId === p.id ? 'border-pine' : 'border-black/10'
                    }`}
                  >
                    <div>
                      <p className="font-medium text-pine">{p.name}</p>
                      {p.style && <p className="text-[#5c5c5c]">Стиль: {p.style}</p>}
                      {p.format && <p className="text-[#5c5c5c]">Формат: {p.format}</p>}
                      {p.constraints && <p className="text-[#5c5c5c]">Ограничения: {p.constraints}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => startEditingProfile(p)} className="text-[#5c5c5c] hover:text-pine">
                        Изм.
                      </button>
                      <button type="button" onClick={() => deleteProfile(p.id)} className="text-[#5c5c5c] hover:text-red-600">
                        ×
                      </button>
                    </div>
                  </li>
                ))}
                {profiles.length === 0 && <p className="text-[#5c5c5c]">Пока нет ни одного профиля.</p>}
              </ul>

              <form onSubmit={saveProfileDraft} className="flex flex-col gap-1 border-t border-black/10 pt-2">
                <p className="font-medium text-pine">{editingProfileId ? 'Редактировать профиль' : 'Новый профиль'}</p>
                <input
                  type="text"
                  value={profileDraft.name}
                  onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })}
                  placeholder="Название (например: Новичок)"
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <textarea
                  value={profileDraft.style}
                  onChange={(event) => setProfileDraft({ ...profileDraft, style: event.target.value })}
                  placeholder="Стиль общения (например: неформально, на «ты»)"
                  rows={2}
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <textarea
                  value={profileDraft.format}
                  onChange={(event) => setProfileDraft({ ...profileDraft, format: event.target.value })}
                  placeholder="Формат ответа (например: коротко, списками)"
                  rows={2}
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <textarea
                  value={profileDraft.constraints}
                  onChange={(event) => setProfileDraft({ ...profileDraft, constraints: event.target.value })}
                  placeholder="Ограничения (например: не больше 5 предложений)"
                  rows={2}
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={!profileDraft.name.trim()}
                    className="rounded-md bg-pine px-3 py-1 text-white disabled:opacity-50"
                  >
                    {editingProfileId ? 'Сохранить' : 'Создать'}
                  </button>
                  {editingProfileId && (
                    <button type="button" onClick={startNewProfile} className="rounded-md border border-black/10 px-3 py-1">
                      Отмена
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {invariantModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setInvariantModalOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col gap-3 overflow-hidden rounded-lg bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="text-sm font-medium text-pine">Инварианты</h2>
              <button
                type="button"
                onClick={() => setInvariantModalOpen(false)}
                className="rounded px-2 text-[#5c5c5c] hover:bg-black/5 hover:text-ink"
              >
                ×
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto text-xs">
              <ul className="flex flex-col gap-1">
                {invariants.map((inv) => (
                  <li
                    key={inv.id}
                    className={`flex items-start justify-between gap-2 rounded-md border p-2 ${
                      editingInvariantId === inv.id ? 'border-pine' : 'border-black/10'
                    } ${inv.active ? '' : 'opacity-50'}`}
                  >
                    <div>
                      <p className="font-medium text-pine">
                        [{INVARIANT_CATEGORY_LABELS[inv.category]}] {inv.title}
                        {!inv.active && ' (выключен)'}
                      </p>
                      <p className="text-[#5c5c5c]">{inv.rule}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <label className="flex items-center gap-1 whitespace-nowrap">
                        <input type="checkbox" checked={inv.active} onChange={() => toggleInvariantActive(inv)} />
                        активен
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => startEditingInvariant(inv)}
                          className="text-[#5c5c5c] hover:text-pine"
                        >
                          Изм.
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteInvariant(inv.id)}
                          className="text-[#5c5c5c] hover:text-red-600"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
                {invariants.length === 0 && <p className="text-[#5c5c5c]">Пока нет ни одного инварианта.</p>}
              </ul>

              <form onSubmit={saveInvariantDraft} className="flex flex-col gap-1 border-t border-black/10 pt-2">
                <p className="font-medium text-pine">
                  {editingInvariantId ? 'Редактировать инвариант' : 'Новый инвариант'}
                </p>
                <select
                  value={invariantDraft.category}
                  onChange={(event) =>
                    setInvariantDraft({ ...invariantDraft, category: event.target.value as InvariantCategory })
                  }
                  className="rounded-md border border-black/10 px-2 py-1"
                >
                  {INVARIANT_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={invariantDraft.title}
                  onChange={(event) => setInvariantDraft({ ...invariantDraft, title: event.target.value })}
                  placeholder="Название (например: База данных)"
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <textarea
                  value={invariantDraft.rule}
                  onChange={(event) => setInvariantDraft({ ...invariantDraft, rule: event.target.value })}
                  placeholder="Правило (например: используем только PostgreSQL)"
                  rows={3}
                  className="rounded-md border border-black/10 px-2 py-1"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={!invariantDraft.title.trim() || !invariantDraft.rule.trim()}
                    className="rounded-md bg-pine px-3 py-1 text-white disabled:opacity-50"
                  >
                    {editingInvariantId ? 'Сохранить' : 'Создать'}
                  </button>
                  {editingInvariantId && (
                    <button
                      type="button"
                      onClick={startNewInvariant}
                      className="rounded-md border border-black/10 px-3 py-1"
                    >
                      Отмена
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
