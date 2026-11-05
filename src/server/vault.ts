import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { t } from '../shared/i18n.js';
import {
  AGENT_BACKENDS,
  COLLECTION_ID_PREFIX,
  MAX_PAPER_TAGS,
  countTags,
  isCollectionId,
  normalizeTags,
  type AgentBackend,
  type AssistantSession,
  type Blog,
  type BlogMeta,
  type ChatMessage,
  type ChatSession,
  type ChatSessionMeta,
  type Collection,
  type CollectionSummary,
  type OutputEntry,
  type PaperFigure,
  type PaperMeta,
  type PaperSummary,
  type Podcast,
  type TagCount,
} from '../shared/types.js';
import { extractPdf } from './pdf.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,120}$/;

export class NotFound extends Error {}
export class BadRequest extends Error {}

export const withoutArxivVersion = (id: string) => id.replace(/v\d+$/, '');

function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new NotFound(t('无效的 ID：{id}', { id }));
  return id;
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Time-sortable and readable, so files in the vault list chronologically. */
export function newOutputId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * The vault is plain files, so it stays useful without this app:
 *
 *   <vault>/papers/<paper-id>/
 *     paper.pdf  meta.json  text.json  thumb.jpg
 *     chats/<id>.json                   (one file per conversation)
 *     figures/fig-<n>.png, figures.json
 *     blogs/<id>.md                     (front matter + Markdown)
 *     podcasts/<id>/podcast.json, audio.mp3
 *   <vault>/collections/<collection-id>/
 *     collection.json  blogs/  podcasts/
 *   <vault>/assistant/<id>.json         (one file per assistant conversation)
 *
 * Blogs and podcasts belong to an "owner", which is either a paper or a collection.
 */
export class Vault {
  constructor(readonly root: string) {
    mkdirSync(this.papersDir, { recursive: true });
  }

  private get papersDir() {
    return join(this.root, 'papers');
  }

  paperDir(id: string): string {
    return join(this.papersDir, assertId(id));
  }

  private get collectionsDir() {
    return join(this.root, 'collections');
  }

  /** The folder holding an owner's blogs and podcasts. */
  ownerDir(id: string): string {
    return isCollectionId(id) ? join(this.collectionsDir, assertId(id)) : this.paperDir(id);
  }

  pdfPath(id: string): string {
    return join(this.paperDir(id), 'paper.pdf');
  }

  thumbPath(id: string): string {
    return join(this.paperDir(id), 'thumb.jpg');
  }

  // Papers ------------------------------------------------------------------

  async importPdf(
    data: Buffer,
    sourceName: string,
    /** Known-good metadata, which wins over what can be guessed from the PDF. */
    known?: Partial<Pick<PaperMeta, 'title' | 'authors' | 'year' | 'abstract' | 'arxivId'>>,
  ): Promise<{ meta: PaperMeta; duplicate: boolean }> {
    if (data.subarray(0, 1024).indexOf('%PDF-') === -1) throw new Error(t('这不是一个有效的 PDF 文件'));
    const sha256 = createHash('sha256').update(data).digest('hex');
    const existing = this.listPapers().find((p) => p.sha256 === sha256);
    if (existing) return { meta: existing, duplicate: true };

    let extract;
    try {
      // pdf.js takes ownership of the buffer it is given, so hand it a copy.
      extract = await extractPdf(new Uint8Array(data));
    } catch (err) {
      throw new Error(t('无法解析 PDF：{error}', { error: (err as Error).message }));
    }
    const fallbackTitle = basename(sourceName).replace(/\.pdf$/i, '');
    const title = known?.title || extract.title || fallbackTitle;
    const id = `${slugify(title) || 'paper'}-${sha256.slice(0, 6)}`;
    const dir = this.paperDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'paper.pdf'), data);
    writeJson(join(dir, 'text.json'), { pages: extract.pages });
    const meta: PaperMeta = {
      id,
      title,
      authors: known?.authors ?? extract.authors,
      year: known?.year ?? extract.year,
      abstract: known?.abstract ?? extract.abstract,
      pages: extract.pages.length,
      sha256,
      arxivId: known?.arxivId,
      sourceName: basename(sourceName),
      addedAt: new Date().toISOString(),
      textChars: extract.pages.reduce((n, p) => n + p.length, 0),
      tags: [],
    };
    writeJson(join(dir, 'meta.json'), meta);
    return { meta, duplicate: false };
  }

  listPapers(): PaperSummary[] {
    if (!existsSync(this.papersDir)) return [];
    const out: PaperSummary[] = [];
    for (const entry of readdirSync(this.papersDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        out.push(this.getPaper(entry.name));
      } catch {
        /* A folder without valid metadata is not a paper; leave it alone. */
      }
    }
    return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  getPaper(id: string): PaperSummary {
    const dir = this.paperDir(id);
    const file = join(dir, 'meta.json');
    if (!existsSync(file)) throw new NotFound(t('论文不存在：{id}', { id }));
    const meta = readJson<PaperMeta>(file);
    const count = (name: string) => (existsSync(join(dir, name)) ? readdirSync(join(dir, name)).filter((f) => !f.startsWith('.')).length : 0);
    return {
      ...meta,
      id,
      // Papers from before tags existed have none, and this file can be edited by hand.
      tags: normalizeTags(meta.tags),
      blogCount: count('blogs'),
      podcastCount: count('podcasts'),
      hasThumb: existsSync(join(dir, 'thumb.jpg')),
    };
  }

  updatePaper(id: string, patch: Partial<Pick<PaperMeta, 'title' | 'authors' | 'year' | 'abstract' | 'tags'>>): PaperSummary {
    const { blogCount: _b, podcastCount: _p, hasThumb: _t, ...meta } = this.getPaper(id);
    const next = { ...meta, ...patch, id };
    if (patch.tags) {
      next.tags = this.spellTags(normalizeTags(patch.tags), id);
      if (next.tags.length > MAX_PAPER_TAGS) throw new BadRequest(t('一篇论文最多 {count} 个标签', { count: MAX_PAPER_TAGS }));
    }
    writeJson(join(this.paperDir(id), 'meta.json'), next);
    return this.getPaper(id);
  }

  listTags(): TagCount[] {
    return countTags(this.listPapers());
  }

  /** Uses the library's spelling of a tag, so that "llm" and "LLM" don't become two filters. */
  spellTags(tags: string[], exceptPaper?: string): string[] {
    const known = new Map<string, string>();
    for (const paper of this.listPapers()) {
      if (paper.id === exceptPaper) continue;
      for (const tag of paper.tags) if (!known.has(tag.toLowerCase())) known.set(tag.toLowerCase(), tag);
    }
    return tags.map((tag) => known.get(tag.toLowerCase()) ?? tag);
  }

  /** Keeps what the paper has, and adds what still fits. */
  addTags(id: string, tags: string[]): PaperSummary {
    return this.updatePaper(id, { tags: normalizeTags([...this.getPaper(id).tags, ...tags]).slice(0, MAX_PAPER_TAGS) });
  }

  /** Finds an imported arXiv paper. Without a version in `arxivId`, any version matches. */
  findArxiv(arxivId: string, papers: PaperSummary[] = this.listPapers()): PaperSummary | undefined {
    const base = withoutArxivVersion(arxivId);
    return papers.find((p) => (arxivId === base ? p.arxivId && withoutArxivVersion(p.arxivId) === base : p.arxivId === arxivId));
  }

  readPages(id: string): string[] {
    return readJson<{ pages: string[] }>(join(this.paperDir(id), 'text.json')).pages;
  }

  /** Moves a paper to `.trash` inside the vault. Nothing is ever hard-deleted by the app. */
  trashPaper(id: string): void {
    this.getPaper(id);
    this.moveToTrash(this.paperDir(id), id);
  }

  private moveToTrash(path: string, name: string): void {
    const trash = join(this.root, '.trash');
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`));
  }

  // Figures -----------------------------------------------------------------

  figuresDir(id: string): string {
    return join(this.paperDir(id), 'figures');
  }

  /** The cached figure list, or null if extraction hasn't run with this `version`. */
  readFigures(id: string, version: number): PaperFigure[] | null {
    const file = join(this.figuresDir(id), 'figures.json');
    if (!existsSync(file)) return null;
    const cached = readJson<{ version: number; figures: PaperFigure[] }>(file);
    return cached.version === version ? cached.figures : null;
  }

  writeFigures(id: string, version: number, figures: PaperFigure[]): void {
    mkdirSync(this.figuresDir(id), { recursive: true });
    writeJson(join(this.figuresDir(id), 'figures.json'), { version, figures });
  }

  // Collections -------------------------------------------------------------

  createCollection(title: string, paperIds: string[]): CollectionSummary {
    const id = `${COLLECTION_ID_PREFIX}${newOutputId()}`;
    const now = new Date().toISOString();
    const collection: Collection = { id, title, paperIds: [...new Set(paperIds)], createdAt: now, updatedAt: now };
    for (const paperId of collection.paperIds) this.getPaper(paperId);
    mkdirSync(this.ownerDir(id), { recursive: true });
    writeJson(join(this.ownerDir(id), 'collection.json'), collection);
    return this.getCollection(id);
  }

  getCollection(id: string): CollectionSummary {
    if (!isCollectionId(id)) throw new NotFound(t('合集不存在：{id}', { id }));
    const dir = this.ownerDir(id);
    const file = join(dir, 'collection.json');
    if (!existsSync(file)) throw new NotFound(t('合集不存在：{id}', { id }));
    const collection = readJson<Collection>(file);
    const count = (name: string) => (existsSync(join(dir, name)) ? readdirSync(join(dir, name)).filter((f) => !f.startsWith('.')).length : 0);
    const papers: PaperSummary[] = [];
    for (const paperId of collection.paperIds) {
      try {
        papers.push(this.getPaper(paperId));
      } catch {
        /* The paper has been removed from the vault. */
      }
    }
    return { ...collection, id, papers, blogCount: count('blogs'), podcastCount: count('podcasts') };
  }

  listCollections(): CollectionSummary[] {
    if (!existsSync(this.collectionsDir)) return [];
    return readdirSync(this.collectionsDir)
      .filter((name) => isCollectionId(name) && existsSync(join(this.collectionsDir, name, 'collection.json')))
      .map((name) => this.getCollection(name))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateCollection(id: string, patch: Partial<Pick<Collection, 'title' | 'paperIds'>>): CollectionSummary {
    const { papers: _p, blogCount: _b, podcastCount: _c, ...current } = this.getCollection(id);
    for (const paperId of patch.paperIds ?? []) this.getPaper(paperId);
    const next: Collection = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.paperIds) next.paperIds = [...new Set(patch.paperIds)];
    writeJson(join(this.ownerDir(id), 'collection.json'), next);
    return this.getCollection(id);
  }

  /** Moves the collection and what it generated to `.trash`. Its papers stay in the library. */
  trashCollection(id: string): void {
    this.getCollection(id);
    this.moveToTrash(this.ownerDir(id), id);
  }

  // Blogs -------------------------------------------------------------------

  private blogPath(ownerId: string, blogId: string) {
    return join(this.ownerDir(ownerId), 'blogs', `${assertId(blogId)}.md`);
  }

  saveBlog(paperId: string, blog: Blog): void {
    const file = this.blogPath(paperId, blog.id);
    mkdirSync(join(this.ownerDir(paperId), 'blogs'), { recursive: true });
    const { markdown, chars: _chars, ...front } = blog;
    const header = Object.entries(front)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    writeFileSync(file, `---\n${header}\n---\n\n${markdown.trim()}\n`);
  }

  getBlog(paperId: string, blogId: string): Blog {
    const file = this.blogPath(paperId, blogId);
    if (!existsSync(file)) throw new NotFound(t('博客不存在：{id}', { id: blogId }));
    const raw = readFileSync(file, 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    const front: Record<string, any> = {};
    for (const line of (match?.[1] ?? '').split('\n')) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      try {
        front[line.slice(0, index).trim()] = JSON.parse(line.slice(index + 1));
      } catch {
        front[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    }
    const markdown = match ? match[2] : raw;
    const mtime = statSync(file).mtime.toISOString();
    return {
      id: blogId,
      title: front.title || markdown.match(/^#\s+(.+)$/m)?.[1] || blogId,
      style: front.style ?? '',
      language: front.language ?? '',
      agent: front.agent ?? '',
      sources: front.sources,
      mode: front.mode,
      createdAt: front.createdAt ?? mtime,
      updatedAt: front.updatedAt ?? mtime,
      markdown,
      chars: markdown.length,
    };
  }

  listBlogs(paperId: string): BlogMeta[] {
    const dir = join(this.ownerDir(paperId), 'blogs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && ID_PATTERN.test(f.slice(0, -3)))
      .map((f) => {
        const { markdown: _m, ...meta } = this.getBlog(paperId, f.slice(0, -3));
        return meta;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  trashBlog(paperId: string, blogId: string): void {
    this.getBlog(paperId, blogId);
    this.moveToTrash(this.blogPath(paperId, blogId), `${paperId}-${blogId}.md`);
  }

  // Podcasts ----------------------------------------------------------------

  podcastDir(paperId: string, podcastId: string): string {
    return join(this.ownerDir(paperId), 'podcasts', assertId(podcastId));
  }

  audioPath(paperId: string, podcastId: string): string {
    return join(this.podcastDir(paperId, podcastId), 'audio.mp3');
  }

  savePodcast(paperId: string, podcast: Podcast): void {
    const dir = this.podcastDir(paperId, podcast.id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'podcast.json'), podcast);
  }

  getPodcast(paperId: string, podcastId: string): Podcast {
    const file = join(this.podcastDir(paperId, podcastId), 'podcast.json');
    if (!existsSync(file)) throw new NotFound(t('播客不存在：{id}', { id: podcastId }));
    return readJson<Podcast>(file);
  }

  listPodcasts(paperId: string): Podcast[] {
    const dir = join(this.ownerDir(paperId), 'podcasts');
    if (!existsSync(dir)) return [];
    const out: Podcast[] = [];
    for (const name of readdirSync(dir)) {
      if (!ID_PATTERN.test(name) || !existsSync(join(dir, name, 'podcast.json'))) continue;
      out.push(this.getPodcast(paperId, name));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  trashPodcast(paperId: string, podcastId: string): void {
    this.getPodcast(paperId, podcastId);
    this.moveToTrash(this.podcastDir(paperId, podcastId), `${paperId}-${podcastId}`);
  }

  // Chat --------------------------------------------------------------------

  private chatsDir(paperId: string) {
    return join(this.paperDir(paperId), 'chats');
  }

  private chatPath(paperId: string, sessionId: string) {
    return join(this.chatsDir(paperId), `${assertId(sessionId)}.json`);
  }

  /** Earlier versions kept one conversation per paper in `chat.json`. It becomes a session. */
  private migrateLegacyChat(paperId: string, fallbackHarness: AgentBackend): void {
    const legacy = join(this.paperDir(paperId), 'chat.json');
    if (!existsSync(legacy)) return;
    const messages = readJson<ChatMessage[]>(legacy);
    if (messages.length) {
      // Messages record which agent answered, as "pi" or "pi · model".
      const label = messages.find((m) => m.agent)?.agent?.split(' ')[0] as AgentBackend | undefined;
      const harness = label && AGENT_BACKENDS.includes(label) ? label : fallbackHarness;
      const session = this.createChat(paperId, messages[0].content, harness);
      this.writeChat(paperId, {
        ...session,
        messages,
        messageCount: messages.length,
        createdAt: messages[0].at,
        updatedAt: messages[messages.length - 1].at,
      });
    }
    rmSync(legacy);
  }

  private writeChat(paperId: string, session: ChatSession): void {
    mkdirSync(this.chatsDir(paperId), { recursive: true });
    writeJson(this.chatPath(paperId, session.id), session);
  }

  /** Newest activity first. */
  listChats(paperId: string, fallbackHarness: AgentBackend): ChatSessionMeta[] {
    this.getPaper(paperId);
    this.migrateLegacyChat(paperId, fallbackHarness);
    const dir = this.chatsDir(paperId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && ID_PATTERN.test(f.slice(0, -5)))
      .map((f) => {
        const { messages: _messages, ...meta } = readJson<ChatSession>(join(dir, f));
        return meta;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createChat(paperId: string, firstQuestion: string, harness: AgentBackend, model = '', thinking = ''): ChatSession {
    const now = new Date().toISOString();
    const title = firstQuestion.trim().replace(/\s+/g, ' ');
    const session: ChatSession = {
      id: newOutputId(),
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      harness,
      model,
      thinking,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.writeChat(paperId, session);
    return session;
  }

  getChat(paperId: string, sessionId: string): ChatSession {
    const file = this.chatPath(paperId, sessionId);
    if (!existsSync(file)) throw new NotFound(t('会话不存在：{id}', { id: sessionId }));
    return readJson<ChatSession>(file);
  }

  appendChat(paperId: string, sessionId: string, message: ChatMessage): void {
    const session = this.getChat(paperId, sessionId);
    const messages = [...session.messages, message];
    this.writeChat(paperId, { ...session, messages, messageCount: messages.length, updatedAt: message.at });
  }

  updateChat(paperId: string, sessionId: string, patch: Partial<Pick<ChatSession, 'model' | 'thinking'>>): ChatSession {
    const next = { ...this.getChat(paperId, sessionId), ...patch };
    this.writeChat(paperId, next);
    return next;
  }

  trashChat(paperId: string, sessionId: string): void {
    this.getChat(paperId, sessionId);
    this.moveToTrash(this.chatPath(paperId, sessionId), `${paperId}-chat-${sessionId}.json`);
  }

  // Assistant ---------------------------------------------------------------

  private get assistantDir() {
    return join(this.root, 'assistant');
  }

  private assistantPath(id: string) {
    return join(this.assistantDir, `${assertId(id)}.json`);
  }

  saveAssistantSession(session: AssistantSession): void {
    mkdirSync(this.assistantDir, { recursive: true });
    writeJson(this.assistantPath(session.id), session);
  }

  getAssistantSession(id: string): AssistantSession {
    const file = this.assistantPath(id);
    if (!existsSync(file)) throw new NotFound(t('会话不存在：{id}', { id }));
    return readJson<AssistantSession>(file);
  }

  listAssistantSessions(): AssistantSession[] {
    if (!existsSync(this.assistantDir)) return [];
    return readdirSync(this.assistantDir)
      .filter((f) => f.endsWith('.json') && ID_PATTERN.test(f.slice(0, -5)))
      .map((f) => readJson<AssistantSession>(join(this.assistantDir, f)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  trashAssistantSession(id: string): void {
    this.getAssistantSession(id);
    this.moveToTrash(this.assistantPath(id), `assistant-${id}.json`);
  }

  // Across the vault --------------------------------------------------------

  listOutputs(): OutputEntry[] {
    const out: OutputEntry[] = [];
    const owners = [
      ...this.listPapers().map((p) => ({ id: p.id, title: p.title })),
      ...this.listCollections().map((c) => ({ id: c.id, title: t('合集：{title}', { title: c.title }) })),
    ];
    for (const owner of owners) {
      for (const blog of this.listBlogs(owner.id)) {
        out.push({
          kind: 'blog',
          paperId: owner.id,
          paperTitle: owner.title,
          id: blog.id,
          title: blog.title,
          style: blog.style,
          language: blog.language,
          chars: blog.chars,
          createdAt: blog.createdAt,
        });
      }
      for (const podcast of this.listPodcasts(owner.id)) {
        out.push({
          kind: 'podcast',
          paperId: owner.id,
          paperTitle: owner.title,
          id: podcast.id,
          title: podcast.title,
          style: podcast.style,
          language: podcast.language,
          status: podcast.status,
          duration: podcast.duration,
          createdAt: podcast.createdAt,
        });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
