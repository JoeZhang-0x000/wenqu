import { randomBytes } from 'node:crypto';
import { ASSISTANT_OWNER, parseReply } from '../shared/assistant.js';
import { t, tx } from '../shared/i18n.js';
import {
  BLOG_STYLES,
  LANGUAGES,
  PODCAST_LENGTHS,
  PODCAST_STYLES,
  isCollectionId,
  type AgentBackend,
  type ArxivHit,
  type ArxivLookup,
  type AssistantAccess,
  type AssistantAction,
  type AssistantMessage,
  type AssistantSession,
  type AssistantSessionMeta,
  type Job,
  type PaperSummary,
  type Settings,
} from '../shared/types.js';
import { parseArxivInput } from './arxiv.js';
import type { AgentRequest } from './agents.js';
import type { JobContext, Jobs } from './jobs.js';
import { assistantPrompt } from './prompts.js';
import { BadRequest, NotFound, newOutputId, withoutArxivVersion, type Vault } from './vault.js';

/** One request from the user, including every read and retry the agent needs along the way. */
const MAX_STEPS = 12;
const MAX_ACTIONS_PER_REPLY = 30;
const MAX_COLLECTION_PAPERS = 12;
const MAX_LISTED_PAPERS = 200;
const MAX_READ_CHARS = 30_000;
const MAX_SEARCH_RESULTS = 25;
/** Generating is slow and each one runs an agent, so a batch runs a few at a time. */
const GENERATION_CONCURRENCY = 3;

export interface AssistantDeps {
  vault(): Vault;
  jobs: Jobs;
  settings(): Settings;
  hasVoiceKey(): boolean;
  runAgent(req: AgentRequest): Promise<string>;
  searchArxiv(vault: Vault, query: string, options: { maxResults?: number; sort?: 'relevance' | 'recent' }): Promise<ArxivHit[]>;
  lookupArxiv(vault: Vault, inputs: string[]): Promise<ArxivLookup[]>;
  importArxiv(vault: Vault, input: string, signal?: AbortSignal): Promise<{ meta: { id: string; title: string }; duplicate: boolean }>;
  startBlog(ownerId: string, body: Record<string, unknown>): { job: Job; blogId: string };
  startPodcast(ownerId: string, body: Record<string, unknown>): { job: Job; podcastId: string };
  synthesize(ownerId: string, podcastId: string): Job;
}

type Args = Record<string, unknown>;

interface Prepared {
  args: Args;
  summary: string;
  details?: AssistantAction['details'];
}

interface Outcome {
  result: string;
  note?: string;
  hits?: ArxivHit[];
  target?: AssistantAction['target'];
}

interface PrepareContext {
  /** The papers that `add_arxiv` calls earlier in this reply will add, by id without its version. */
  incoming: Map<string, { id: string; title: string }>;
  /** Looked up together, because arXiv's pacing would make one call per paper slow. */
  lookups: Map<string, ArxivLookup>;
}

interface Tool {
  access: AssistantAccess;
  /** How the agent learns to use it. */
  doc: string;
  /** Long-running tools may run alongside each other within a batch. */
  long?: boolean;
  /** Validates the arguments and describes the action, with no side effects. */
  prepare(args: Args, ctx: PrepareContext): Promise<Prepared> | Prepared;
  run(args: Args, ctx: JobContext, session: AssistantSession): Promise<Outcome> | Outcome;
}

/** A problem with what the agent asked for. It goes back to the agent, which can correct itself. */
class ToolError extends Error {}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function stringArg(args: Args, key: string, max = 2000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ToolError(`"${key}" is longer than ${max} characters.`);
  return trimmed || undefined;
}

function requireString(args: Args, key: string, max?: number): string {
  const value = stringArg(args, key, max);
  if (!value) throw new ToolError(`"${key}" is required.`);
  return value;
}

function intArg(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`"${key}" must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function choiceArg(args: Args, key: string, choices: string[]): string | undefined {
  const value = stringArg(args, key);
  if (value !== undefined && !choices.includes(value)) throw new ToolError(`"${key}" must be one of: ${choices.join(', ')}.`);
  return value;
}

/** Keeps what was given, so defaults keep following the user's settings until an action runs. */
const defined = (values: Args): Args => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

/** What's in the library is only mentioned once the agent may read it, because searching doesn't ask first. */
const describeHit = (hit: ArxivHit, canReadLibrary: boolean) => ({
  arxivId: hit.arxivId,
  title: hit.title,
  authors: hit.authors.slice(0, 6),
  year: hit.year,
  abstract: hit.abstract ? clip(hit.abstract, 600) : undefined,
  inLibraryAs: canReadLibrary ? hit.paperId : undefined,
});

const describePaper = (p: PaperSummary) => ({
  id: p.id,
  title: p.title,
  authors: p.authors.slice(0, 6),
  year: p.year,
  arxivId: p.arxivId,
  pages: p.pages,
  blogs: p.blogCount,
  podcasts: p.podcastCount,
});

export class Assistant {
  private readonly tools: Record<string, Tool>;

  constructor(private readonly deps: AssistantDeps) {
    this.tools = this.buildTools();
  }

  private get vault() {
    return this.deps.vault();
  }

  // Sessions ----------------------------------------------------------------

  list(): AssistantSessionMeta[] {
    return this.vault.listAssistantSessions().map((stored) => {
      const session = this.settleInterrupted(stored);
      const { messages, allowReads: _allowReads, ...meta } = session;
      return { ...meta, pending: pendingActions(session).length };
    });
  }

  get(id: string): AssistantSession {
    return this.settleInterrupted(this.vault.getAssistantSession(id));
  }

  /** Actions cut off by a restart may or may not have finished, so they are reported and never rerun. */
  private settleInterrupted(session: AssistantSession): AssistantSession {
    if (this.deps.jobs.isActive(session.id)) return session;
    let changed = false;
    const messages = session.messages.map((m) => ({
      ...m,
      actions: m.actions?.map((a) => {
        if (a.status !== 'running' && a.status !== 'approved') return a;
        changed = true;
        return { ...a, status: 'failed' as const, result: 'Interrupted before it finished. It may or may not have taken effect.', note: t('操作被中断') };
      }),
    }));
    if (!changed) return session;
    const next = { ...session, messages };
    this.vault.saveAssistantSession(next);
    return next;
  }

  create(message: string, harness: AgentBackend, model: string, thinking: string) {
    const text = requireMessage(message);
    const now = new Date().toISOString();
    const session: AssistantSession = {
      id: newOutputId(),
      title: clip(text.replace(/\s+/g, ' '), 60),
      harness,
      model,
      thinking,
      allowReads: false,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.vault.saveAssistantSession(session);
    this.addMessage(session.id, { role: 'user', content: text, at: now });
    return { sessionId: session.id, job: this.startTurn(session.id, text) };
  }

  send(id: string, message: string) {
    const text = requireMessage(message);
    this.assertIdle(id);
    // Sending something new answers any open question with a no, so nothing is left waiting behind it.
    this.mutate(id, (session) => {
      for (const action of pendingActions(session)) {
        action.status = 'rejected';
        action.result = 'The user sent a new message instead of approving this.';
      }
    });
    this.addMessage(id, { role: 'user', content: text, at: new Date().toISOString() });
    return { job: this.startTurn(id, text) };
  }

  /** Runs what was approved and rejects the rest. Rejecting everything ends the turn without asking the agent again. */
  decide(id: string, approve: string[], allowReads = false) {
    this.assertIdle(id);
    const session = this.get(id);
    const pending = pendingActions(session);
    if (!pending.length) throw new BadRequest(t('没有等待审批的操作'));
    const approved = pending.filter((a) => approve.includes(a.id)).map((a) => a.id);
    this.mutate(id, (current) => {
      if (allowReads) current.allowReads = true;
      for (const action of pendingActions(current)) {
        if (approved.includes(action.id)) {
          action.status = 'approved';
        } else {
          action.status = 'rejected';
          action.result = 'The user rejected this.';
        }
      }
    });
    this.deps.jobs.send({ type: 'library' });
    if (!approved.length) return { job: null };
    return { job: this.startTurn(id, session.title, approved) };
  }

  update(id: string, patch: { model?: string; thinking?: string }): AssistantSession {
    return this.mutate(id, (session) => Object.assign(session, patch));
  }

  remove(id: string): void {
    this.assertIdle(id);
    this.vault.trashAssistantSession(id);
    this.deps.jobs.send({ type: 'library' });
  }

  private assertIdle(id: string): void {
    this.vault.getAssistantSession(id);
    if (this.deps.jobs.isActive(id)) throw new BadRequest(t('这个会话正在回答，请等它结束'));
  }

  /** Reads, changes and writes within one tick, so concurrent actions in a batch can't overwrite each other. */
  private mutate(id: string, change: (session: AssistantSession) => void): AssistantSession {
    const session = this.vault.getAssistantSession(id);
    change(session);
    this.vault.saveAssistantSession(session);
    return session;
  }

  private addMessage(id: string, message: AssistantMessage): void {
    this.mutate(id, (session) => {
      session.messages.push(message);
      session.messageCount = session.messages.length;
      session.updatedAt = message.at;
    });
    this.deps.jobs.send({ type: 'library' });
  }

  private patchAction(id: string, actionId: string, patch: Partial<AssistantAction>): void {
    this.mutate(id, (session) => {
      const action = session.messages.flatMap((m) => m.actions ?? []).find((a) => a.id === actionId);
      if (action) Object.assign(action, patch);
    });
    this.deps.jobs.send({ type: 'library' });
  }

  // A turn ------------------------------------------------------------------

  private startTurn(id: string, label: string, approved: string[] = []): Job {
    return this.deps.jobs.start(
      { kind: 'assistant', paperId: ASSISTANT_OWNER, targetId: id, label: t('助手：{title}', { title: clip(label, 40) }) },
      async (ctx) => {
        await this.runActions(id, approved, ctx);
        await this.converse(id, ctx);
      },
      (error, canceled) => {
        this.mutate(id, (session) => {
          for (const action of session.messages.flatMap((m) => m.actions ?? [])) {
            if (action.status === 'running' || action.status === 'approved') {
              action.status = 'canceled';
              action.result = canceled ? 'The user stopped this before it finished.' : `Stopped by an error: ${error}`;
            }
          }
        });
        this.addMessage(id, { role: 'assistant', content: canceled ? t('已取消') : error, error: true, at: new Date().toISOString() });
      },
    );
  }

  /** Asks the agent what to do next, until it finishes or something needs the user. */
  private async converse(id: string, ctx: JobContext): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step++) {
      const session = this.vault.getAssistantSession(id);
      const raw = await this.deps.runAgent({
        backend: session.harness,
        model: session.model || undefined,
        thinking: session.thinking || undefined,
        ...assistantPrompt({
          tools: this.toolDocs(),
          messages: session.messages,
          today: new Date().toISOString().slice(0, 10),
        }),
        onDelta: ctx.delta,
        signal: ctx.signal,
      });
      const { text, calls, error } = parseReply(raw);
      const actions = await this.prepareAll(calls, session, error);
      ctx.signal.throwIfAborted();
      this.addMessage(id, {
        role: 'assistant',
        content: text,
        actions: actions.length ? actions : undefined,
        agent: [session.harness, session.model, session.thinking].filter(Boolean).join(' · '),
        at: new Date().toISOString(),
      });
      ctx.reset();
      if (!actions.length) return;
      await this.runActions(id, actions.filter((a) => a.status === 'approved').map((a) => a.id), ctx);
      if (actions.some((a) => a.status === 'pending')) return;
    }
    this.addMessage(id, {
      role: 'assistant',
      content: t('这一轮的步骤已达上限，已经先停下。可以回复“继续”接着做。'),
      error: true,
      at: new Date().toISOString(),
    });
  }

  private needsApproval(access: AssistantAccess, session: AssistantSession): boolean {
    if (access === 'write') return true;
    if (access === 'external') return false;
    return !this.canReadLibrary(session);
  }

  private canReadLibrary(session: AssistantSession): boolean {
    return session.allowReads || this.deps.settings().assistant.autoApproveReads;
  }

  /** Bad requests become failed actions that go back to the agent. They never reach the user to approve. */
  private async prepareAll(calls: { tool: string; args: Args }[], session: AssistantSession, error?: string): Promise<AssistantAction[]> {
    const failed = (tool: string, args: Args, result: string, access: AssistantAccess = 'external'): AssistantAction => ({
      id: randomBytes(6).toString('hex'),
      tool,
      args,
      access,
      summary: t('无效的操作请求：{tool}', { tool: clip(tool, 60) }),
      status: 'failed',
      result,
    });
    const actions: AssistantAction[] = [];
    if (error) actions.push(failed('invalid', {}, `${error} Nothing in that block was run. Write it again as valid JSON.`));
    // A model that loses track of its format can repeat itself, and the user shouldn't approve the same thing twice.
    calls = calls.filter((call, i) => calls.findIndex((other) => JSON.stringify(other) === JSON.stringify(call)) === i);
    const inputs = calls.flatMap((c) => (c.tool === 'add_arxiv' && typeof c.args.input === 'string' ? [c.args.input.trim()] : []));
    const lookups = inputs.length ? await this.deps.lookupArxiv(this.vault, [...new Set(inputs)]) : [];
    const ctx: PrepareContext = { incoming: new Map(), lookups: new Map(lookups.map((l) => [l.input, l])) };
    for (const [index, call] of calls.entries()) {
      if (index >= MAX_ACTIONS_PER_REPLY) {
        actions.push(failed('too_many', {}, `Only the first ${MAX_ACTIONS_PER_REPLY} actions were accepted. Ask for the rest once those are finished.`));
        break;
      }
      const tool = Object.hasOwn(this.tools, call.tool) ? this.tools[call.tool] : undefined;
      if (!tool) {
        actions.push(failed(call.tool, call.args, `There is no tool called "${call.tool}".`));
        continue;
      }
      try {
        const prepared = await tool.prepare(call.args, ctx);
        actions.push({
          id: randomBytes(6).toString('hex'),
          tool: call.tool,
          access: tool.access,
          ...prepared,
          status: this.needsApproval(tool.access, session) ? 'pending' : 'approved',
        });
      } catch (err) {
        if (!(err instanceof ToolError || err instanceof NotFound || err instanceof BadRequest)) throw err;
        actions.push(failed(call.tool, call.args, (err as Error).message, tool.access));
      }
    }
    return actions;
  }

  /** In the order asked for, so a later action can use what an earlier one added. Neighbouring generations share a pool. */
  private async runActions(id: string, actionIds: string[], ctx: JobContext): Promise<void> {
    if (!actionIds.length) return;
    const all = this.vault.getAssistantSession(id).messages.flatMap((m) => m.actions ?? []);
    const queue = actionIds.flatMap((actionId) => all.find((a) => a.id === actionId) ?? []);
    let done = 0;
    const report = () => ctx.progress({ done, total: queue.length, note: t('已完成 {done}/{total} 项操作', { done, total: queue.length }) });
    const runOne = async (action: AssistantAction) => {
      await this.runAction(id, action, ctx);
      done++;
      report();
    };
    report();
    for (let i = 0; i < queue.length; ) {
      if (!this.tools[queue[i].tool].long) {
        await runOne(queue[i++]);
        continue;
      }
      let end = i;
      while (end < queue.length && this.tools[queue[end].tool].long) end++;
      await pool(queue.slice(i, end), GENERATION_CONCURRENCY, runOne);
      i = end;
    }
    ctx.signal.throwIfAborted();
  }

  private async runAction(id: string, action: AssistantAction, ctx: JobContext): Promise<void> {
    ctx.signal.throwIfAborted();
    this.patchAction(id, action.id, { status: 'running' });
    try {
      const outcome = await this.tools[action.tool].run(action.args, ctx, this.vault.getAssistantSession(id));
      this.patchAction(id, action.id, { status: 'done', ...outcome });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      const message = (err as Error).message;
      this.patchAction(id, action.id, { status: 'failed', result: message, note: message });
    }
  }

  /** Waits for a background job started by a tool. Stopping the assistant stops the job too. */
  private async waitFor(targetId: string, ctx: JobContext): Promise<void> {
    const stop = () => this.deps.jobs.cancelTarget(targetId);
    ctx.signal.addEventListener('abort', stop, { once: true });
    try {
      const job = await this.deps.jobs.settled(targetId);
      if (job?.status === 'failed' || job?.status === 'canceled') throw new Error(job.error ?? t('已取消'));
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
  }

  // Tools -------------------------------------------------------------------

  private toolDocs(): string {
    return Object.entries(this.tools)
      .map(([name, tool]) => `- ${name}${tool.access === 'write' ? ' [approval]' : ''}: ${tool.doc}`)
      .join('\n');
  }

  /** A paper or collection id, or the arXiv id of a paper in the library. */
  private resolveOwner(ref: string): { id: string; title: string } {
    if (isCollectionId(ref)) {
      const collection = this.vault.getCollection(ref);
      return { id: collection.id, title: collection.title };
    }
    const arxivId = parseArxivInput(ref);
    const found = arxivId ? this.vault.findArxiv(arxivId) : undefined;
    const paper = found ?? this.vault.getPaper(ref);
    return { id: paper.id, title: paper.title };
  }

  /**
   * Like `resolveOwner`, but also accepts a paper that this same batch is about to add.
   * The ref it returns is what runs, so it can't come to mean a different paper by then.
   */
  private resolveOwnerInBatch(ref: string, ctx: PrepareContext): { ref: string; title: string } {
    const arxivId = parseArxivInput(ref);
    const known = !arxivId || this.vault.findArxiv(arxivId);
    if (known) {
      const { id, title } = this.resolveOwner(ref);
      return { ref: id, title };
    }
    const incoming = ctx.incoming.get(withoutArxivVersion(arxivId));
    if (!incoming) throw new ToolError(`"${ref}" is not in the library, and no earlier action in this block adds it.`);
    return { ref: incoming.id, title: incoming.title };
  }

  private assertUnused(paperId: string): void {
    if (this.deps.jobs.list().some((j) => j.paperId === paperId && j.status === 'running')) {
      throw new BadRequest(t('这篇论文还有任务在运行'));
    }
  }

  private buildTools(): Record<string, Tool> {
    const styles = PODCAST_STYLES.map((s) => s.id);
    const blogStyles = BLOG_STYLES.map((s) => s.id);
    const languages = LANGUAGES.map((l) => l.id);
    const lengths = PODCAST_LENGTHS.map((l) => l.id);

    return {
      list_papers: {
        access: 'read',
        doc: `Lists the papers in the library, newest first. args: query? (every word must appear in the title, authors, abstract or full text; matches in the text come with a page and snippet), limit? (1-${MAX_LISTED_PAPERS}).`,
        prepare: (args) => {
          const query = stringArg(args, 'query', 200);
          const limit = intArg(args, 'limit', 1, MAX_LISTED_PAPERS);
          return { args: defined({ query, limit }), summary: query ? t('在书架中搜索：{query}', { query }) : t('查看书架') };
        },
        run: (args) => {
          const query = args.query as string | undefined;
          const limit = (args.limit as number | undefined) ?? MAX_LISTED_PAPERS;
          const papers = this.vault.listPapers();
          const rows = query ? this.searchLibrary(papers, query) : papers.map((p) => ({ paper: p, match: undefined }));
          const shown = rows.slice(0, limit);
          return {
            result: JSON.stringify({ total: rows.length, shown: shown.length, papers: shown.map((r) => ({ ...describePaper(r.paper), match: r.match })) }),
            note: t('{count} 篇论文', { count: rows.length }),
          };
        },
      },

      get_paper: {
        access: 'read',
        doc: 'Shows one paper: details, abstract, its blog posts and podcast episodes, and the collections it is in. args: paper (id or arXiv id).',
        prepare: (args) => {
          const { id, title } = this.resolveOwnerPaper(requireString(args, 'paper'));
          return { args: { paper: id }, summary: t('查看论文：{title}', { title }) };
        },
        run: (args) => {
          const id = args.paper as string;
          const paper = this.vault.getPaper(id);
          return {
            result: JSON.stringify({
              ...describePaper(paper),
              authors: paper.authors,
              abstract: paper.abstract,
              blogs: this.vault.listBlogs(id).map((b) => ({ id: b.id, title: b.title, style: b.style, language: b.language })),
              podcasts: this.vault.listPodcasts(id).map((e) => ({ id: e.id, title: e.title, status: e.status, language: e.language })),
              collections: this.vault.listCollections().filter((c) => c.paperIds.includes(id)).map((c) => ({ id: c.id, title: c.title })),
            }),
            target: { ownerId: id },
          };
        },
      },

      read_paper: {
        access: 'read',
        doc: `Reads a paper's extracted text, with page markers, up to ${MAX_READ_CHARS} characters per call. args: paper, from_page?, to_page?.`,
        prepare: (args) => {
          const { id, title } = this.resolveOwnerPaper(requireString(args, 'paper'));
          const from = intArg(args, 'from_page', 1, 100_000) ?? 1;
          const pages = this.vault.getPaper(id).pages;
          const to = Math.min(intArg(args, 'to_page', 1, 100_000) ?? pages, pages);
          if (from > to) throw new ToolError(`This paper has ${pages} pages, so that range is empty.`);
          return { args: { paper: id, from_page: from, to_page: to }, summary: t('读取论文：{title}（第 {from}–{to} 页）', { title, from, to }) };
        },
        run: (args) => {
          const id = args.paper as string;
          const from = args.from_page as number;
          const to = args.to_page as number;
          const text = this.vault
            .readPages(id)
            .slice(from - 1, to)
            .map((page, i) => `[p.${from + i}]\n${page}`)
            .join('\n\n');
          return {
            result: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[Cut off here. Ask for later pages to continue.]` : text || '(This paper has no extractable text.)',
            target: { ownerId: id },
          };
        },
      },

      list_collections: {
        access: 'read',
        doc: 'Lists the collections in the library and the papers in each. No args.',
        prepare: () => ({ args: {}, summary: t('查看合集列表') }),
        run: () => ({
          result: JSON.stringify(
            this.vault.listCollections().map((c) => ({
              id: c.id,
              title: c.title,
              papers: c.papers.map((p) => ({ id: p.id, title: p.title })),
              blogs: c.blogCount,
              podcasts: c.podcastCount,
            })),
          ),
        }),
      },

      search_arxiv: {
        access: 'external',
        doc: `Searches arXiv. This looks outside the library and changes nothing. args: query (keywords, or arXiv field syntax such as ti:"graph neural" AND cat:cs.LG), max_results? (1-${MAX_SEARCH_RESULTS}, default 10), sort? ("relevance" or "recent").`,
        prepare: (args) => {
          const query = requireString(args, 'query', 500);
          return {
            args: defined({
              query,
              max_results: intArg(args, 'max_results', 1, MAX_SEARCH_RESULTS),
              sort: choiceArg(args, 'sort', ['relevance', 'recent']),
            }),
            summary: t('在 arXiv 搜索：{query}', { query }),
          };
        },
        run: async (args, _ctx, session) => {
          const hits = await this.deps.searchArxiv(this.vault, args.query as string, {
            maxResults: args.max_results as number | undefined,
            sort: args.sort as 'relevance' | 'recent' | undefined,
          });
          return { result: JSON.stringify(hits.map((hit) => describeHit(hit, this.canReadLibrary(session)))), note: t('{count} 篇论文', { count: hits.length }), hits };
        },
      },

      add_arxiv: {
        access: 'write',
        doc: 'Downloads a paper from arXiv into the library. args: input (arXiv id or link).',
        prepare: (args, ctx) => {
          const input = requireString(args, 'input', 300);
          const lookup = ctx.lookups.get(input);
          if (!lookup?.id) throw new ToolError(`"${input}" is not an arXiv id or link.`);
          if (lookup.paperId) throw new ToolError('Already in the library.');
          if (lookup.status === 'missing') throw new ToolError(`arXiv has no paper ${lookup.id}.`);
          const title = lookup.meta?.title ?? lookup.id;
          ctx.incoming.set(withoutArxivVersion(lookup.id), { id: lookup.id, title });
          return {
            args: { input: lookup.id },
            summary: t('从 arXiv 添加：{title}', { title }),
            details: [
              { label: 'arXiv', value: lookup.id },
              ...(lookup.meta?.authors.length ? [{ label: t('作者'), value: clip(lookup.meta.authors.join(', '), 200) }] : []),
              ...(lookup.meta?.abstract ? [{ label: t('摘要'), value: clip(lookup.meta.abstract, 400) }] : []),
            ],
          };
        },
        run: async (args, ctx) => {
          const { meta, duplicate } = await this.deps.importArxiv(this.vault, args.input as string, ctx.signal);
          return {
            result: JSON.stringify({ id: meta.id, title: meta.title, alreadyInLibrary: duplicate }),
            note: duplicate ? t('已在书架中') : undefined,
            target: { ownerId: meta.id },
          };
        },
      },

      update_paper: {
        access: 'write',
        doc: "Corrects a paper's details. Only the fields given change. args: paper, title?, authors? (array of names), year?, abstract?.",
        prepare: (args) => {
          const { id } = this.resolveOwnerPaper(requireString(args, 'paper'));
          const current = this.vault.getPaper(id);
          const title = stringArg(args, 'title', 500);
          const abstract = stringArg(args, 'abstract', 20_000);
          const year = intArg(args, 'year', 1000, 9999);
          let authors: string[] | undefined;
          if (args.authors !== undefined) {
            if (!Array.isArray(args.authors) || args.authors.some((a) => typeof a !== 'string' || !a.trim())) {
              throw new ToolError('"authors" must be an array of names.');
            }
            authors = (args.authors as string[]).map((a) => a.trim());
          }
          const details: NonNullable<AssistantAction['details']> = [];
          const change = (label: string, before: string, after: string | undefined) => {
            // The new value is shown whole, because it's what gets stored.
            if (after !== undefined && after !== before) details.push({ label, before: clip(before, 400), value: after });
          };
          change(t('标题'), current.title, title);
          change(t('作者'), current.authors.join(', '), authors?.join(', '));
          change(t('年份'), String(current.year ?? ''), year === undefined ? undefined : String(year));
          change(t('摘要'), current.abstract ?? '', abstract);
          if (!details.length) throw new ToolError('Nothing would change.');
          return { args: defined({ paper: id, title, authors, year, abstract }), summary: t('修改论文：{title}', { title: current.title }), details };
        },
        run: (args) => {
          const { paper, ...patch } = args;
          const updated = this.vault.updatePaper(paper as string, patch);
          this.deps.jobs.send({ type: 'library' });
          return { result: JSON.stringify(describePaper(updated)), target: { ownerId: updated.id } };
        },
      },

      delete_paper: {
        access: 'write',
        doc: "Moves a paper, with its blog posts, podcast episodes and chats, to the vault's trash. args: paper.",
        prepare: (args) => {
          const { id } = this.resolveOwnerPaper(requireString(args, 'paper'));
          this.assertUnused(id);
          const paper = this.vault.getPaper(id);
          return {
            args: { paper: id },
            summary: t('把论文移到回收站：{title}', { title: paper.title }),
            details: paper.blogCount || paper.podcastCount ? [{ label: t('连同'), value: t('{podcasts} 期播客、{blogs} 篇博客', { podcasts: paper.podcastCount, blogs: paper.blogCount }) }] : undefined,
          };
        },
        run: (args) => {
          const id = args.paper as string;
          this.assertUnused(id);
          this.vault.trashPaper(id);
          this.deps.jobs.send({ type: 'library' });
          return { result: 'Moved to the trash.' };
        },
      },

      create_collection: {
        access: 'write',
        doc: `Groups papers into a collection, which can then have one episode or post about all of them. args: title, papers (array of 2-${MAX_COLLECTION_PAPERS} paper ids).`,
        prepare: (args) => {
          const title = requireString(args, 'title', 200);
          if (!Array.isArray(args.papers)) throw new ToolError('"papers" must be an array of paper ids.');
          const resolved = (args.papers as unknown[]).map((ref) => this.resolveOwnerPaper(String(ref)));
          const ids = [...new Map(resolved.map((p) => [p.id, p])).values()];
          if (ids.length < 2 || ids.length > MAX_COLLECTION_PAPERS) throw new ToolError(`A collection needs 2 to ${MAX_COLLECTION_PAPERS} papers.`);
          return {
            args: { title, papers: ids.map((p) => p.id) },
            summary: t('创建合集：{title}', { title }),
            details: [{ label: t('论文'), value: ids.map((p) => clip(p.title, 80)).join(' · ') }],
          };
        },
        run: (args) => {
          const collection = this.vault.createCollection(args.title as string, args.papers as string[]);
          this.deps.jobs.send({ type: 'library' });
          return { result: JSON.stringify({ id: collection.id, title: collection.title }), target: { ownerId: collection.id } };
        },
      },

      generate_podcast: {
        access: 'write',
        long: true,
        doc: `Writes a podcast script for a paper or collection with an agent, and optionally synthesizes the audio. Leave options out to use the user's settings. args: paper (id, collection id, or the arXiv id of a paper added earlier in this block), style? (${styles.join(', ')}), language? (${languages.join(', ')}), length? (${lengths.join(', ')}), instructions?, synthesize? (true also produces audio, which uses the user's paid speech service).`,
        prepare: (args, ctx) => {
          const { ref, title } = this.resolveOwnerInBatch(requireString(args, 'paper', 300), ctx);
          const defaults = this.deps.settings().podcast;
          const askedStyle = choiceArg(args, 'style', styles);
          const askedLength = choiceArg(args, 'length', lengths);
          const instructions = stringArg(args, 'instructions');
          const language = choiceArg(args, 'language', languages) ?? defaults.language;
          const hasVoice = this.deps.hasVoiceKey();
          // Direct generation has no script to shape, so asking for any of these means an agent writes it.
          const specific = Boolean(askedStyle || askedLength || instructions);
          const engine = isCollectionId(ref) || specific ? 'agent' : defaults.engine;
          if (engine === 'doubao' && !hasVoice) throw new ToolError('The default engine needs a speech API key, and none is set.');
          const synthesize = args.synthesize === true;
          const audio =
            engine === 'doubao' || (synthesize && hasVoice)
              ? [{ label: t('音频'), value: t('会调用语音服务合成音频，可能产生费用') }]
              : synthesize
                ? [{ label: t('音频'), value: t('没有配置语音 API Key，只会生成脚本') }]
                : [];
          const style = askedStyle ?? defaults.style;
          const length = askedLength ?? defaults.length;
          // Every choice is settled now, so changing a setting later can't change what was approved.
          const shared = { paper: ref, language, engine };
          if (engine === 'doubao') {
            return { args: shared, summary: t('生成播客：{title}', { title }), details: [{ label: t('方式'), value: t('豆包直出') }, ...audio] };
          }
          return {
            args: defined({
              ...shared,
              style,
              customStyle: style === 'custom' ? defaults.customStyle : undefined,
              length,
              instructions,
              synthesize: (synthesize && hasVoice) || undefined,
            }),
            summary: t('生成播客：{title}', { title }),
            details: [
              { label: t('风格'), value: tx(PODCAST_STYLES.find((s) => s.id === style)?.label ?? t('自定义')) },
              { label: t('语言'), value: LANGUAGES.find((l) => l.id === language)?.label ?? language },
              { label: t('长度'), value: tx(PODCAST_LENGTHS.find((l) => l.id === length)?.label ?? length) },
              ...(instructions ? [{ label: t('额外要求'), value: instructions }] : []),
              ...audio,
            ],
          };
        },
        run: async (args, ctx) => {
          const { id: ownerId } = this.resolveOwner(args.paper as string);
          const { podcastId } = this.deps.startPodcast(ownerId, {
            style: args.style,
            customStyle: args.customStyle,
            language: args.language,
            length: args.length,
            engine: args.engine,
            instructions: args.instructions,
            autoSynthesize: args.synthesize === true,
          });
          await this.waitFor(podcastId, ctx);
          const podcast = this.vault.getPodcast(ownerId, podcastId);
          if (podcast.status === 'failed') throw new Error(podcast.error ?? t('合成被中断，可以重新合成。'));
          return {
            result: JSON.stringify({ podcast: podcast.id, paper: ownerId, title: podcast.title, status: podcast.status, duration: podcast.duration }),
            note: podcast.status === 'draft' ? t('脚本已生成，还没有合成音频') : undefined,
            target: { ownerId, tab: 'podcast', item: podcast.id },
          };
        },
      },

      generate_blog: {
        access: 'write',
        long: true,
        doc: `Writes a blog post about a paper or collection with an agent. args: paper (as for generate_podcast), style? (${blogStyles.join(', ')}), language? (${languages.join(', ')}), instructions?.`,
        prepare: (args, ctx) => {
          const { ref, title } = this.resolveOwnerInBatch(requireString(args, 'paper', 300), ctx);
          const defaults = this.deps.settings().blog;
          const style = choiceArg(args, 'style', blogStyles) ?? defaults.style;
          const language = choiceArg(args, 'language', languages) ?? defaults.language;
          const instructions = stringArg(args, 'instructions');
          return {
            args: defined({ paper: ref, style, customStyle: style === 'custom' ? defaults.customStyle : undefined, language, instructions }),
            summary: t('生成博客：{title}', { title }),
            details: [
              { label: t('风格'), value: tx(BLOG_STYLES.find((s) => s.id === style)?.label ?? t('自定义')) },
              { label: t('语言'), value: LANGUAGES.find((l) => l.id === language)?.label ?? language },
              ...(instructions ? [{ label: t('额外要求'), value: instructions }] : []),
            ],
          };
        },
        run: async (args, ctx) => {
          const { id: ownerId } = this.resolveOwner(args.paper as string);
          const { blogId } = this.deps.startBlog(ownerId, { style: args.style, customStyle: args.customStyle, language: args.language, instructions: args.instructions });
          await this.waitFor(blogId, ctx);
          const blog = this.vault.getBlog(ownerId, blogId);
          return {
            result: JSON.stringify({ blog: blog.id, paper: ownerId, title: blog.title, chars: blog.chars }),
            target: { ownerId, tab: 'blog', item: blog.id },
          };
        },
      },

      synthesize_podcast: {
        access: 'write',
        long: true,
        doc: "Turns an existing episode's script into audio, using the user's paid speech service. args: paper, podcast (episode id).",
        prepare: (args) => {
          const { id: ownerId } = this.resolveOwner(requireString(args, 'paper', 300));
          const podcast = this.vault.getPodcast(ownerId, requireString(args, 'podcast', 200));
          if (!this.deps.hasVoiceKey()) throw new ToolError('No speech API key is set. Ask the user to add one in Settings.');
          return {
            args: { paper: ownerId, podcast: podcast.id },
            summary: t('合成音频：{title}', { title: podcast.title }),
            details: [{ label: t('音频'), value: t('会调用语音服务合成音频，可能产生费用') }],
          };
        },
        run: async (args, ctx) => {
          const ownerId = args.paper as string;
          const podcastId = args.podcast as string;
          this.deps.synthesize(ownerId, podcastId);
          await this.waitFor(podcastId, ctx);
          const podcast = this.vault.getPodcast(ownerId, podcastId);
          if (podcast.status !== 'ready') throw new Error(podcast.error ?? t('合成被中断，可以重新合成。'));
          return {
            result: JSON.stringify({ podcast: podcast.id, status: podcast.status, duration: podcast.duration }),
            target: { ownerId, tab: 'podcast', item: podcast.id },
          };
        },
      },
    };
  }

  /** Like `resolveOwner`, for tools that only make sense for a paper. */
  private resolveOwnerPaper(ref: string): { id: string; title: string } {
    if (isCollectionId(ref)) throw new ToolError(`"${ref}" is a collection, and this needs a paper.`);
    return this.resolveOwner(ref);
  }

  /** Every word must match. Details count for more than the text, which is what makes this useful as a ranking. */
  private searchLibrary(papers: PaperSummary[], query: string) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const inDetails: { paper: PaperSummary; match?: { page: number; snippet: string } }[] = [];
    const inText: typeof inDetails = [];
    for (const paper of papers) {
      const details = `${paper.title} ${paper.authors.join(' ')} ${paper.abstract ?? ''}`.toLowerCase();
      if (words.every((w) => details.includes(w))) {
        inDetails.push({ paper });
        continue;
      }
      let pages: string[];
      try {
        pages = this.vault.readPages(paper.id);
      } catch {
        continue;
      }
      if (!words.every((w) => details.includes(w) || pages.some((page) => page.toLowerCase().includes(w)))) continue;
      const missing = words.find((w) => !details.includes(w)) as string;
      const index = pages.findIndex((page) => page.toLowerCase().includes(missing));
      const at = pages[index].toLowerCase().indexOf(missing);
      inText.push({ paper, match: { page: index + 1, snippet: pages[index].slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ') } });
    }
    return [...inDetails, ...inText];
  }
}

function requireMessage(message: string): string {
  const text = message.trim();
  if (!text) throw new BadRequest(t('问题不能为空'));
  return text;
}

function pendingActions(session: AssistantSession): AssistantAction[] {
  return session.messages.flatMap((m) => m.actions ?? []).filter((a) => a.status === 'pending');
}

/** Waits for every worker even after one fails, so nothing is still changing once this returns. */
async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, worker));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
