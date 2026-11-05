export type AgentBackend = 'pi' | 'claude' | 'codex';
export const AGENT_BACKENDS: AgentBackend[] = ['claude', 'codex', 'pi'];

export type PodcastEngine = 'agent' | 'doubao';
export type PodcastLength = 'short' | 'medium' | 'long';

export type UiLanguage = 'auto' | 'zh' | 'en';

export interface Settings {
  vaultPath: string;
  uiLanguage: UiLanguage;
  agent: {
    backend: AgentBackend;
    /** Empty string means the CLI's own default model. */
    models: Record<AgentBackend, string>;
    /** Empty string means the CLI's own default thinking level. */
    thinking: Record<AgentBackend, string>;
  };
  podcast: {
    language: string;
    style: string;
    customStyle: string;
    length: PodcastLength;
    engine: PodcastEngine;
    speakers: [string, string];
    speechRate: number;
    headMusic: boolean;
    tailMusic: boolean;
  };
  blog: {
    language: string;
    style: string;
    customStyle: string;
  };
  assistant: {
    /** Lets the assistant read inside papers without asking. Changes always need approval. */
    autoApproveReads: boolean;
  };
  library: {
    /** Runs an agent to tag each paper the user adds. The assistant chooses its own tags. */
    autoTag: boolean;
  };
  doubao: {
    apiKey: string;
    resourceId: string;
  };
}

/** Settings as sent to the browser: the API key never leaves the server. */
export interface PublicSettings extends Omit<Settings, 'doubao'> {
  doubao: {
    hasKey: boolean;
    keyPreview: string;
    keyFromEnv: boolean;
    resourceId: string;
  };
}

export interface SettingsPatch {
  vaultPath?: string;
  uiLanguage?: UiLanguage;
  agent?: Partial<Settings['agent']>;
  podcast?: Partial<Settings['podcast']>;
  blog?: Partial<Settings['blog']>;
  assistant?: Partial<Settings['assistant']>;
  library?: Partial<Settings['library']>;
  doubao?: Partial<Settings['doubao']>;
}

export interface Option {
  id: string;
  label: string;
  hint?: string;
}

export const LANGUAGES: Option[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

export const PODCAST_STYLES: (Option & { prompt: string })[] = [
  {
    id: 'conversational',
    label: '轻松对谈',
    hint: '两位朋友聊论文，有来有回',
    prompt: 'A relaxed conversation between two friends. Natural back-and-forth, everyday analogies, light humour, genuine curiosity.',
  },
  {
    id: 'deep',
    label: '深度解析',
    hint: '面向同行，讲清方法和细节',
    prompt: 'A rigorous deep dive for researchers in the field. Walk through the method, key experiments and numbers, and what the results do and do not show.',
  },
  {
    id: 'debate',
    label: '观点交锋',
    hint: '一方支持，一方质疑',
    prompt: 'A friendly debate. Host A argues for the paper; host B plays sceptic and presses on assumptions, weak evidence and limitations. End with a fair synthesis.',
  },
  {
    id: 'beginner',
    label: '零基础科普',
    hint: '不需要任何背景知识',
    prompt: 'Popular science for listeners with no background. Define every term the first time it appears, and prefer concrete stories and analogies over jargon.',
  },
  {
    id: 'brief',
    label: '快讯简报',
    hint: '只讲结论和为什么重要',
    prompt: 'A tight news briefing. What was done, what was found, why it matters, and what to watch next. No digressions.',
  },
];

export const BLOG_STYLES: (Option & { prompt: string })[] = [
  {
    id: 'explainer',
    label: '深度解读',
    hint: '结构完整的长文',
    prompt: 'A well-structured long-form explainer for technical readers: motivation, core idea, method, results, limitations, and why it matters.',
  },
  {
    id: 'popular',
    label: '通俗科普',
    hint: '给非专业读者',
    prompt: 'A popular-science article for curious non-experts. Open with a hook, use analogies, avoid formulas unless indispensable, and explain every term.',
  },
  {
    id: 'engineer',
    label: '工程师视角',
    hint: '能怎么用、怎么复现',
    prompt: 'A practitioner\'s write-up: what can be applied today, implementation details, costs and pitfalls, and how to reproduce it. Include pseudocode where it helps.',
  },
  {
    id: 'critical',
    label: '批判性评论',
    hint: '方法与证据的审视',
    prompt: 'A critical review in the style of a discerning peer reviewer. Assess assumptions, evidence quality, threats to validity and how far the claims really go.',
  },
  {
    id: 'social',
    label: '社交媒体短文',
    hint: '短小、适合转发',
    prompt: 'A short, punchy post for social media: a strong first line, 3 to 5 takeaways, and one closing thought. Under 500 words or 800 Chinese characters.',
  },
];

export const PODCAST_LENGTHS: (Option & { minutes: number })[] = [
  { id: 'short', label: '约 5 分钟', minutes: 5 },
  { id: 'medium', label: '约 10 分钟', minutes: 10 },
  { id: 'long', label: '约 20 分钟', minutes: 20 },
];

export const SPEAKER_PAIRS: { id: string; label: string; speakers: [string, string]; names: [string, string]; namesEn: [string, string] }[] = [
  {
    id: 'mizai',
    label: '大义先生 × 咪仔同学',
    speakers: ['zh_male_dayixiansheng_v2_saturn_bigtts', 'zh_female_mizaitongxue_v2_saturn_bigtts'],
    names: ['大义先生', '咪仔同学'],
    namesEn: ['Dayi', 'Mizai'],
  },
  {
    id: 'liufei',
    label: '刘飞 × 潇磊',
    speakers: ['zh_male_liufei_v2_saturn_bigtts', 'zh_male_xiaolei_v2_saturn_bigtts'],
    names: ['刘飞', '潇磊'],
    namesEn: ['Liu Fei', 'Xiaolei'],
  },
];

/** Limits of the Doubao `nlp_texts` input. */
export const MAX_ROUND_CHARS = 300;
export const MAX_SCRIPT_CHARS = 10000;

export interface PaperMeta {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  pages: number;
  sha256: string;
  arxivId?: string;
  sourceName: string;
  addedAt: string;
  textChars: number;
  tags: string[];
}

export const MAX_TAG_CHARS = 40;
export const MAX_PAPER_TAGS = 12;

export interface TagCount {
  tag: string;
  count: number;
}

/** Tidies tags from any source. Tags differing only in case count as one, and the first spelling stays. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.replace(/^[\s#＃]+/, '').trim().replace(/\s+/g, ' ');
    if (tag && tag.length <= MAX_TAG_CHARS && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()];
}

export function changeTags(current: string[], add: string[], remove: string[] = []): string[] {
  const removed = new Set(remove.map((tag) => tag.toLowerCase()));
  return normalizeTags([...current.filter((tag) => !removed.has(tag.toLowerCase())), ...add]);
}

/** Most used first. */
export function countTags(papers: { tags: string[] }[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const paper of papers) for (const tag of paper.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export type ArxivMeta = Required<Pick<PaperMeta, 'title' | 'authors' | 'arxivId'>> & Pick<PaperMeta, 'year' | 'abstract'>;

export interface ArxivLookup {
  input: string;
  /** The arXiv id this input names, or null if it doesn't name one. */
  id: string | null;
  /** `unknown` means arXiv couldn't be asked, which doesn't stop an import. */
  status: 'invalid' | 'found' | 'missing' | 'unknown';
  meta?: ArxivMeta;
  /** Set when the paper is already in the vault. */
  paperId?: string;
}

export interface PaperSummary extends PaperMeta {
  blogCount: number;
  podcastCount: number;
  hasThumb: boolean;
}

export interface PaperFigure {
  /** The number in the paper's own caption, such as "3" or "3.1". */
  n: string;
  label: string;
  caption: string;
  page: number;
  /** File name inside the paper's `figures` folder. */
  file: string;
  width: number;
  height: number;
  /** Set when the user removed a bad crop, so it stays out of generated posts. */
  excluded?: boolean;
}

export interface BlogMeta {
  id: string;
  title: string;
  style: string;
  language: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  chars: number;
  /** For a collection's post: the papers behind citations such as [2:p.5], in order. */
  sources?: string[];
  mode?: CollectionMode;
}

export interface Blog extends BlogMeta {
  markdown: string;
}

/** Whether a set of papers is walked through one by one, or woven together by theme. */
export type CollectionMode = 'digest' | 'review';

export const COLLECTION_MODES: Option[] = [
  { id: 'digest', label: '本周论文', hint: '逐篇讲，串成一期' },
  { id: 'review', label: '小型综述', hint: '按主题组织，比较异同' },
];

export const COLLECTION_ID_PREFIX = 'collection--';
export const isCollectionId = (id: string) => id.startsWith(COLLECTION_ID_PREFIX);

export interface Collection {
  id: string;
  title: string;
  paperIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionSummary extends Collection {
  /** Papers that still exist; a paper removed from the vault simply drops out. */
  papers: PaperSummary[];
  blogCount: number;
  podcastCount: number;
}

export interface ScriptRound {
  /** Index into the podcast's speakers pair. */
  speaker: 0 | 1;
  text: string;
  start?: number;
  end?: number;
}

export type PodcastStatus = 'draft' | 'synthesizing' | 'ready' | 'failed';

export interface Podcast {
  id: string;
  title: string;
  status: PodcastStatus;
  engine: PodcastEngine;
  language: string;
  style: string;
  mode?: CollectionMode;
  agent?: string;
  speakers: [string, string];
  speechRate: number;
  headMusic: boolean;
  tailMusic: boolean;
  rounds: ScriptRound[];
  duration?: number;
  audioBytes?: number;
  error?: string;
  inputTruncated?: boolean;
  usage?: { inputTextTokens: number; outputAudioTokens: number };
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Text the user had selected in the PDF when asking. */
  selection?: string;
  page?: number;
  agent?: string;
  error?: boolean;
  at: string;
}

/** A paper found on arXiv. `paperId` is set when it is already in the vault. */
export interface ArxivHit extends ArxivMeta {
  paperId?: string;
}

/**
 * `catalog` only looks at the library's details (titles, authors, abstracts) or this chat's own requests,
 * `read` looks inside papers, `write` changes the library, and `external` only asks arXiv.
 * Whether an action waits for the user follows from this, never from the agent.
 */
export type AssistantAccess = 'catalog' | 'read' | 'write' | 'external';
export type AssistantActionStatus = 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'rejected' | 'canceled';

export interface AssistantAction {
  id: string;
  tool: string;
  /** Validated and normalized. This is exactly what runs if approved. */
  args: Record<string, unknown>;
  access: AssistantAccess;
  /** Written by the server from `args`, so the agent can't misdescribe what it asks for. */
  summary: string;
  details?: { label: string; value: string; before?: string }[];
  /** What the user can change on the card before approving. Only these keys, and only these choices, can be set. */
  options?: { key: string; label: string; value: string; choices: Option[] }[];
  status: AssistantActionStatus;
  /** What the agent is told happened. */
  result?: string;
  /** What the user is told happened, when it adds to the summary. */
  note?: string;
  /**
   * Set once an action has been approved and then didn't finish, so the user can run it again as it stands.
   * `unsure` means it may already have taken effect. Requests that never reached the user don't have this.
   */
  retry?: 'ready' | 'unsure';
  hits?: ArxivHit[];
  /** What this produced or refers to, for a link. */
  target?: { ownerId: string; tab?: 'blog' | 'podcast'; item?: string };
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: AssistantAction[];
  agent?: string;
  error?: boolean;
  at: string;
}

export interface AssistantSessionMeta {
  id: string;
  title: string;
  harness: AgentBackend;
  model: string;
  thinking: string;
  messageCount: number;
  /** Actions waiting for the user. */
  pending: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSession extends Omit<AssistantSessionMeta, 'pending'> {
  /** The user chose to stop being asked about reading papers in this chat. */
  allowReads: boolean;
  messages: AssistantMessage[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  /** The agent CLI answering in this session. Chosen when it is created, then fixed. */
  harness: AgentBackend;
  /** Empty means the harness's own default. Can change between messages. */
  model: string;
  /** Thinking level. Empty means the harness's own default. */
  thinking: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[];
}

export type JobKind = 'blog' | 'script' | 'synth' | 'chat' | 'assistant' | 'tags';
export type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

export interface Job {
  id: string;
  kind: JobKind;
  paperId: string;
  /** Blog or podcast id this job writes to, when known. */
  targetId?: string;
  label: string;
  status: JobStatus;
  /** Streamed agent output so far. */
  text: string;
  progress?: { done: number; total?: number; note?: string };
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'delta'; jobId: string; text: string }
  | { type: 'library' };

export interface AgentModel {
  id: string;
  label: string;
  /** Thinking levels this model accepts. Empty means it can't be adjusted. */
  efforts: string[];
  defaultEffort?: string;
}

export interface AgentStatus {
  backend: AgentBackend;
  installed: boolean;
  version?: string;
  /** What the CLI itself reports, not a list kept in this app. */
  models: AgentModel[];
  defaultModel?: string;
  /** Levels the CLI accepts when no particular model is chosen. */
  efforts: string[];
  defaultEffort?: string;
}

export interface OutputEntry {
  kind: 'blog' | 'podcast';
  /** The paper or collection this belongs to. */
  paperId: string;
  paperTitle: string;
  id: string;
  title: string;
  style: string;
  language: string;
  status?: PodcastStatus;
  duration?: number;
  chars?: number;
  createdAt: string;
}
