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
import { readPaperRepo, type PaperRepo } from '../shared/repo.js';
import { COVER_VERSION, type CoverMarker } from './cover.js';
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
import type { PdfLink } from './repo-detect.js';

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
 *     paper.pdf  meta.json  text.json  thumb.jpg  cover.json
 *     repo-links.json                   (GitHub links read from the PDF, a cache)
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
    const thumb = statSync(join(dir, 'thumb.jpg'), { throwIfNoEntry: false });
    const cover = this.readCover(id);
    return {
      ...meta,
      id,
      // Papers from before tags existed have none, and this file can be edited by hand.
      tags: normalizeTags(meta.tags),
      // The same goes for a link, which ends up in git's arguments and on disk.
      repo: readPaperRepo(meta.repo),
      blogCount: count('blogs'),
      podcastCount: count('podcasts'),
      hasThumb: Boolean(thumb),
      thumbStamp: thumb ? Math.round(thumb.mtimeMs) : 0,
      // A failure is settled too: there's no point in trying again on every view.
      coverStale: cover?.version !== COVER_VERSION || (cover.kind !== 'failed' && !thumb),
    };
  }

  /** A paper as `meta.json` holds it, without the fields worked out on reading. */
  private storedMeta(id: string): PaperMeta {
    const { blogCount: _b, podcastCount: _p, hasThumb: _t, thumbStamp: _s, coverStale: _c, ...meta } = this.getPaper(id);
    return meta;
  }

  updatePaper(id: string, patch: Partial<Pick<PaperMeta, 'title' | 'authors' | 'year' | 'abstract' | 'tags'>>): PaperSummary {
    const meta = this.storedMeta(id);
    // A link only changes through setPaperRepo, whatever a caller's patch happens to hold.
    const next = { ...meta, ...patch, id, repo: meta.repo };
    if (patch.tags) {
      next.tags = this.spellTags(normalizeTags(patch.tags), id);
      if (next.tags.length > MAX_PAPER_TAGS) throw new BadRequest(t('一篇论文最多 {count} 个标签', { count: MAX_PAPER_TAGS }));
    }
    writeJson(join(this.paperDir(id), 'meta.json'), next);
    return this.getPaper(id);
  }

  /** Links a repository, or removes the link when given nothing. */
  setPaperRepo(id: string, repo: PaperRepo | undefined): PaperSummary {
    writeJson(join(this.paperDir(id), 'meta.json'), { ...this.storedMeta(id), repo: readPaperRepo(repo) });
    return this.getPaper(id);
  }

  /** The cached links, or null if the PDF hasn't been read with this `version`. */
  readRepoLinks(id: string, version: number): PdfLink[] | null {
    const file = join(this.paperDir(id), 'repo-links.json');
    if (!existsSync(file)) return null;
    try {
      const cached = readJson<{ version: number; links: PdfLink[] }>(file);
      return cached.version === version && Array.isArray(cached.links) ? cached.links : null;
    } catch {
      return null;
    }
  }

  writeRepoLinks(id: string, version: number, links: PdfLink[]): void {
    writeJson(join(this.paperDir(id), 'repo-links.json'), { version, links });
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

  // Covers ------------------------------------------------------------------

  /** A `thumb.jpg` without a readable marker is from before figures were used as covers. */
  private readCover(id: string): CoverMarker | null {
    try {
      return readJson<CoverMarker>(join(this.paperDir(id), 'cover.json'));
    } catch {
      return null;
    }
  }

  /** The old image stays in place until the new one is complete. Returns the new `thumbStamp`. */
  writeCover(id: string, image: Buffer, kind: 'figure' | 'page', page: number): number {
    const file = this.thumbPath(id);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, image);
    renameSync(tmp, file);
    writeJson(join(this.paperDir(id), 'cover.json'), { version: COVER_VERSION, kind, page } satisfies CoverMarker);
    return this.getPaper(id).thumbStamp;
  }

  /** Whatever the card shows now stays, and this version won't try again. */
  settleCoverAsFailed(id: string): void {
    writeJson(join(this.paperDir(id), 'cover.json'), { version: COVER_VERSION, kind: 'failed' } satisfies CoverMarker);
  }

  /** Has the cover chosen again on its next view, keeping the current image until then. */
  invalidateCover(id: string): void {
    const cover = this.readCover(id);
    if (cover) writeJson(join(this.paperDir(id), 'cover.json'), { ...cover, version: 0 } satisfies CoverMarker);
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

  /** The figures the user removed, whichever version found them. */
  removedFigures(id: string): Set<string> {
    try {
      const { figures } = readJson<{ figures: PaperFigure[] }>(join(this.figuresDir(id), 'figures.json'));
      return new Set(figures.filter((f) => f.excluded).map((f) => f.n));
    } catch {
      return new Set();
    }
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

  // Chats from before they ran on the assistant -----------------------------

  /**
   * Reader chats used to be kept with their paper, first as one `chat.json` and then one file per
   * session under `chats/`. They are now assistant chats beside that paper, so they move over once.
   */
  migrateChats(paperId: string, fallbackHarness: AgentBackend): void {
    this.getPaper(paperId);
    const legacy = join(this.paperDir(paperId), 'chat.json');
    const old: ChatSession[] = [];
    if (existsSync(legacy)) {
      const messages = readJson<ChatMessage[]>(legacy);
      if (messages.length) {
        // Messages record which agent answered, as "pi" or "pi · model".
        const label = messages.find((m) => m.agent)?.agent?.split(' ')[0] as AgentBackend | undefined;
        const title = messages[0].content.trim().replace(/\s+/g, ' ');
        old.push({
          id: newOutputId(),
          title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
          harness: label && AGENT_BACKENDS.includes(label) ? label : fallbackHarness,
          model: '',
          thinking: '',
          messages,
          messageCount: messages.length,
          createdAt: messages[0].at,
          updatedAt: messages[messages.length - 1].at,
        });
      }
    }
    const dir = join(this.paperDir(paperId), 'chats');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && ID_PATTERN.test(f.slice(0, -5))) : [];
    for (const f of files) old.push(readJson<ChatSession>(join(dir, f)));
    for (const chat of old) {
      // An id already taken by an assistant chat would otherwise be overwritten.
      const id = existsSync(this.assistantPath(chat.id)) ? newOutputId() : chat.id;
      this.saveAssistantSession({ ...chat, id, paperId, allowReads: false });
    }
    // Only once everything is safely written.
    if (existsSync(legacy)) rmSync(legacy);
    for (const f of files) rmSync(join(dir, f));
    if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true });
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
