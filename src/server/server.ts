import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { parseAnswer } from '../shared/assistant.js';
import { getLocale, setLocale, t } from '../shared/i18n.js';
import { parseRepoUrl, repoLabel, shortSha, type PaperRepo, type RepoRef } from '../shared/repo.js';
import {
  AGENT_BACKENDS,
  MAX_ROUND_CHARS,
  MAX_SCRIPT_CHARS,
  isCollectionId,
  type AgentBackend,
  type Blog,
  type ChatMessage,
  type CollectionMode,
  type CoverPlan,
  type PaperFigure,
  type PaperSummary,
  type Podcast,
  type RepoState,
  type ScriptRound,
  type ServerEvent,
  type SettingsPatch,
} from '../shared/types.js';
import { runAgent } from './agents.js';
import { detectAgents } from './harness.js';
import { applyUpdate, updateStatus } from './update.js';
import { importArxiv, lookupArxiv, searchArxiv } from './arxiv.js';
import { Config, expandHome, repoCacheDir } from './config.js';
import { chooseCover, locateFirstFigurePage } from './cover.js';
import { DoubaoError, synthesizePodcast } from './doubao.js';
import { FIGURES_VERSION, byPosition, extractFigures, figurePath, figuresSupported, inlineFigures, keepKnownFigures } from './figures.js';
import { Jobs, type JobContext } from './jobs.js';
import { PDFJS_DIR, pageMarkedText } from './pdf.js';
import { blogPrompt, chatPrompt, collectionSource, paperSource, parseTagReply, scriptPrompt, tagsPrompt, type SourceFigure } from './prompts.js';
import { RepoStore, type RepoStoreOptions } from './repo.js';
import { answerWithRepo } from './repo-chat.js';
import { REPO_LINKS_VERSION, rankRepoCandidates, readPdfLinks, type PdfLink } from './repo-detect.js';
import { parseScript } from './script.js';
import { Assistant } from './assistant.js';
import { BadRequest, NotFound, Vault, newOutputId } from './vault.js';

/** Enough for almost any paper while keeping the agent call responsive. */
const MAX_PAPER_CHARS = 150_000;
/** Doubao's documented `input_text` range for direct generation. */
const MAX_DIRECT_INPUT = 20_000;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_COLLECTION_PAPERS = 12;
const MAX_ARXIV_LOOKUP = 50;
/** The opening of a paper says enough to tag it. */
const MAX_TAGGING_CHARS = 8_000;
const MAX_KNOWN_TAGS = 200;

const webRoot = () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'web'), join(here, '../../dist/web')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
};

export interface AppOptions {
  config: Config;
  /** Allowed in the Host and Origin checks, in addition to the server's own port. */
  devOrigin?: string;
  /** Replaces this process with the current build. Missing where that isn't possible, as in the dev server. */
  restart?: () => void;
  /** Changes how repositories are fetched, so that tests never touch the network. */
  repos?: Pick<RepoStoreOptions, 'cloneUrl' | 'protocols' | 'maxBytes' | 'timeoutMs'>;
}

export function createApp({ config, devOrigin, restart, repos: repoOptions }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const jobs = new Jobs();
  let vault = new Vault(config.get().vaultPath);
  const repos = new RepoStore({ root: repoCacheDir(), ...repoOptions });

  /**
   * This server can spawn agents and read the vault, and any website can reach
   * localhost from the user's browser. Reject foreign Hosts (DNS rebinding) and
   * foreign Origins (cross-site requests).
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const allowedHost = host === '127.0.0.1' || host === 'localhost';
    const origin = req.headers.origin;
    let allowedOrigin = true;
    if (origin) {
      allowedOrigin = origin === devOrigin || origin === `http://${req.headers.host}`;
    }
    if (!allowedHost || !allowedOrigin) {
      res.status(403).json({ error: t('只接受来自本机页面的请求') });
      return;
    }
    // One user on one machine, so the last request's language applies to the whole server.
    const locale = req.headers['x-wenqu-locale'];
    if (locale === 'zh' || locale === 'en') setLocale(locale);
    next();
  });

  const json = express.json({ limit: '5mb' });
  const api = express.Router();

  api.get('/state', async (_req, res) => {
    res.json({ settings: config.public() });
  });

  api.get('/settings', (_req, res) => res.json(config.public()));
  api.put('/settings', json, (req, res) => {
    const patch = req.body as SettingsPatch;
    if (patch.vaultPath !== undefined) {
      const path = expandHome(patch.vaultPath.trim());
      if (!path.startsWith('/')) throw new BadRequest(t('Vault 路径必须是绝对路径'));
      patch.vaultPath = path;
    }
    if (patch.doubao?.apiKey !== undefined) patch.doubao.apiKey = patch.doubao.apiKey.trim();
    let nextVault: Vault | undefined;
    if (patch.vaultPath) {
      // Running jobs write to the vault they started in, so switching under them would lose their output.
      if (jobs.list().some((j) => j.status === 'running')) throw new BadRequest(t('还有任务在运行，请等它们结束后再切换 Vault'));
      // Created first, so a path that can't be used leaves the current vault in place.
      try {
        nextVault = new Vault(patch.vaultPath);
      } catch (err) {
        throw new BadRequest(t('无法使用这个目录：{error}', { error: (err as Error).message }));
      }
    }
    config.update(patch);
    if (nextVault) {
      vault = nextVault;
      jobs.send({ type: 'library' });
    }
    res.json(config.public());
  });

  // Updates -----------------------------------------------------------------

  api.get('/update', async (_req, res) => {
    const status = await updateStatus();
    res.json(restart ? status : { ...status, blocked: t('开发模式下请手动更新') });
  });
  api.post('/update', async (_req, res) => {
    if (!restart) throw new BadRequest(t('开发模式下请手动更新'));
    // A restart would lose them, since tasks only live in memory.
    if (jobs.list().some((j) => j.status === 'running')) throw new BadRequest(t('还有任务在运行，请等它们结束后再更新'));
    const { blocked } = await updateStatus();
    if (blocked) throw new BadRequest(blocked);
    await applyUpdate();
    res.on('finish', restart);
    res.json({ ok: true });
  });

  // Agents ------------------------------------------------------------------

  api.get('/agents', async (req, res) => res.json(await detectAgents(Boolean(req.query.refresh))));
  api.post('/agents/test', json, async (req, res) => {
    const { backend, model, thinking } = req.body as { backend: AgentBackend; model?: string; thinking?: string };
    const started = Date.now();
    try {
      const reply = await runAgent({
        backend,
        model: model || undefined,
        thinking: thinking || undefined,
        system: 'You are a connectivity check.',
        prompt: 'Reply with exactly: OK',
        signal: AbortSignal.timeout(90_000),
      });
      res.json({ ok: true, reply: reply.trim().slice(0, 80), ms: Date.now() - started });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message, ms: Date.now() - started });
    }
  });

  const agentChoice = (body: { backend?: AgentBackend; model?: string; thinking?: string }) => {
    const { agent } = config.get();
    const backend = body.backend ?? agent.backend;
    return { backend, model: body.model ?? agent.models[backend] ?? '', thinking: body.thinking ?? agent.thinking[backend] ?? '' };
  };
  const agentLabel = (a: { backend: AgentBackend; model: string; thinking?: string }) =>
    [a.backend, a.model, a.thinking].filter(Boolean).join(' · ');

  // Doubao ------------------------------------------------------------------

  api.post('/doubao/test', json, async (req, res) => {
    const settings = config.get();
    const apiKey = (req.body?.apiKey as string | undefined)?.trim() || config.apiKey();
    if (!apiKey) {
      res.json({ ok: false, error: t('尚未配置 API Key') });
      return;
    }
    const [first] = settings.podcast.speakers;
    const started = Date.now();
    let bytes = 0;
    try {
      await synthesizePodcast({
        apiKey,
        resourceId: settings.doubao.resourceId,
        maxRetries: 0,
        signal: AbortSignal.timeout(60_000),
        payload: {
          action: 3,
          nlp_texts: [{ speaker: first, text: '连接测试。' }],
          use_head_music: false,
          use_tail_music: false,
          audio_config: { format: 'mp3', sample_rate: 24000, speech_rate: 0 },
          speaker_info: { random_order: false, speakers: settings.podcast.speakers },
        },
        onAudio: (chunk) => {
          bytes += chunk.length;
        },
      });
      res.json({ ok: true, ms: Date.now() - started, bytes });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message, ms: Date.now() - started });
    }
  });

  // Library -----------------------------------------------------------------

  api.get('/papers', (_req, res) => res.json(vault.listPapers()));
  api.get('/outputs', (_req, res) => res.json(withLiveStatus(vault.listOutputs())));

  /** The request body is the PDF itself, which spares the app a multipart parser. */
  api.post(
    '/papers',
    express.raw({ type: () => true, limit: MAX_PDF_BYTES }),
    async (req, res) => {
      const name = String(req.query.filename ?? 'paper.pdf');
      const { meta, duplicate } = await vault.importPdf(req.body as Buffer, name).catch((err: Error) => {
        throw new BadRequest(err.message);
      });
      jobs.send({ type: 'library' });
      if (req.query.autoTag === '1' && !duplicate) tagNewPaper(meta.id);
      res.json({ paper: vault.getPaper(meta.id), duplicate });
    },
  );

  /** Tells the add-paper dialog what was pasted, before anything is downloaded. */
  api.post('/papers/arxiv/lookup', json, async (req, res) => {
    const inputs = req.body?.inputs;
    if (!Array.isArray(inputs) || inputs.length > MAX_ARXIV_LOOKUP) throw new BadRequest(t('一次最多添加 {count} 篇', { count: MAX_ARXIV_LOOKUP }));
    res.json(await lookupArxiv(vault, inputs.map(String)));
  });

  api.post('/papers/arxiv', json, async (req, res) => {
    const { meta, duplicate } = await importArxiv(vault, String(req.body?.input ?? '')).catch((err: Error) => {
      throw new BadRequest(err.message);
    });
    jobs.send({ type: 'library' });
    if (req.body?.autoTag === true && !duplicate) tagNewPaper(meta.id);
    res.json({ paper: vault.getPaper(meta.id), duplicate });
  });

  api.get('/papers/:id', (req, res) => res.json(vault.getPaper(req.params.id)));
  api.patch('/papers/:id', json, (req, res) => {
    const { title, authors, year, abstract, tags } = req.body;
    if (tags !== undefined && !Array.isArray(tags)) throw new BadRequest(t('请求无效'));
    const patch = Object.fromEntries(
      Object.entries({ title, authors, year, abstract, tags }).filter(([, v]) => v !== undefined),
    );
    const paper = vault.updatePaper(req.params.id, patch);
    jobs.send({ type: 'library' });
    res.json(paper);
  });
  api.delete('/papers/:id', (req, res) => {
    const link = vault.getPaper(req.params.id).repo;
    vault.trashPaper(req.params.id);
    if (link) releaseClones(link);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });
  api.get('/papers/:id/pdf', (req, res) => sendFile(res, vault.pdfPath(req.params.id), 'application/pdf'));
  api.get('/papers/:id/thumb', (req, res) => sendFile(res, vault.thumbPath(req.params.id), 'image/jpeg'));
  api.put('/papers/:id/thumb', express.raw({ type: () => true, limit: '4mb' }), (req, res) => {
    vault.getPaper(req.params.id);
    const { kind, page } = req.query;
    if ((kind !== 'figure' && kind !== 'page') || !Number.isInteger(Number(page)) || Number(page) < 1) throw new BadRequest(t('请求无效'));
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequest(t('请求无效'));
    res.json({ thumbStamp: vault.writeCover(req.params.id, req.body, kind, Number(page)) });
  });
  api.post('/papers/:id/reveal', (req, res) => {
    vault.getPaper(req.params.id);
    revealInFileManager(vault.paperDir(req.params.id));
    res.json({ ok: true });
  });

  // Tags --------------------------------------------------------------------

  api.get('/tags', (_req, res) => res.json(vault.listTags()));

  const canTag = (paper: PaperSummary) => paper.textChars >= 50 || Boolean(paper.abstract);
  /** Adding a batch shouldn't start an agent per paper, so these wait their turn. */
  let tagQueue: Promise<void> = Promise.resolve();

  const startTagging = (paperId: string) => {
    const language = getLocale();
    const label = t('标签：{title}', { title: vault.getPaper(paperId).title });
    return jobs.start({ kind: 'tags', paperId, targetId: `tags-${paperId}`, label }, async ({ signal }) => {
      const turn = tagQueue;
      let finished!: () => void;
      tagQueue = new Promise((resolve) => (finished = resolve));
      try {
        // Canceling one that is still waiting shouldn't have to wait.
        await Promise.race([
          turn,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        ]);
        signal.throwIfAborted();
        const meta = vault.getPaper(paperId);
        const { text, truncated } = pageMarkedText(vault.readPages(paperId), MAX_TAGGING_CHARS);
        const known = vault.listTags().slice(0, MAX_KNOWN_TAGS).map((c) => c.tag);
        const raw = await runAgent({ ...agentChoice({}), ...tagsPrompt({ meta, text, truncated, known, language }), signal });
        vault.addTags(paperId, parseTagReply(raw));
      } finally {
        void turn.then(finished);
      }
    });
  };

  /** A scan with no details has nothing to go on, and that's no reason to bother the user while adding it. */
  const tagNewPaper = (paperId: string) => {
    if (canTag(vault.getPaper(paperId))) startTagging(paperId);
  };

  api.post('/papers/:id/tags/generate', (req, res) => {
    if (!canTag(vault.getPaper(req.params.id))) throw new BadRequest(t('这份 PDF 没有可提取的文字（可能是扫描件），暂时无法生成内容。'));
    if (jobs.isActive(`tags-${req.params.id}`)) throw new BadRequest(t('正在生成这篇论文的标签'));
    res.json(startTagging(req.params.id));
  });

  const paperContext = (paperId: string) => {
    const meta = vault.getPaper(paperId);
    const pages = vault.readPages(paperId);
    if (!pages.join('').trim()) {
      throw new BadRequest(t('这份 PDF 没有可提取的文字（可能是扫描件），暂时无法生成内容。'));
    }
    const { text, truncated } = pageMarkedText(pages, MAX_PAPER_CHARS);
    return { meta, pages, text, truncated };
  };

  // Figures -----------------------------------------------------------------

  /** Migrating a big library shouldn't parse many PDFs at once, on the thread that answers requests. */
  let heavyQueue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    const result = heavyQueue.then(job, job);
    heavyQueue = result.catch(() => {});
    return result;
  };

  /** Two requests for the same paper share one extraction. */
  const extracting = new Map<string, Promise<PaperFigure[]>>();

  const figuresOf = (paperId: string): Promise<PaperFigure[]> => {
    const cached = vault.readFigures(paperId, FIGURES_VERSION);
    if (cached) return Promise.resolve(cached);
    const running = extracting.get(paperId);
    if (running) return running;
    const work = inTurn(async () => {
      if (!(await figuresSupported())) return [];
      const dir = vault.figuresDir(paperId);
      rmSync(dir, { recursive: true, force: true });
      const figures = await extractFigures(new Uint8Array(readFileSync(vault.pdfPath(paperId))), dir);
      vault.writeFigures(paperId, FIGURES_VERSION, figures);
      return figures;
    })
      .catch((err: Error) => {
        // A post without pictures is still a good post.
        console.error(t('图表提取失败 {id}: {error}', { id: paperId, error: err.message }));
        return [] as PaperFigure[];
      })
      .finally(() => extracting.delete(paperId));
    extracting.set(paperId, work);
    return work;
  };

  api.get('/papers/:id/figures', async (req, res) => {
    vault.getPaper(req.params.id);
    res.json({ supported: await figuresSupported(), figures: await figuresOf(req.params.id) });
  });
  api.get('/papers/:id/figures/:file', (req, res) => {
    if (!/^fig-[\w-]+\.png$/.test(req.params.file)) throw new NotFound(t('文件不存在'));
    sendFile(res, join(vault.figuresDir(req.params.id), req.params.file), 'image/png');
  });
  api.patch('/papers/:id/figures/:n', json, async (req, res) => {
    const before = await figuresOf(req.params.id);
    const figures = before.map((f) => (f.n === req.params.n ? { ...f, excluded: Boolean(req.body?.excluded) } : f));
    vault.writeFigures(req.params.id, FIGURES_VERSION, figures);
    // Removing a figure means its crop is bad, so it can't stay on the cover. Other edits leave the cover alone.
    const first = (list: PaperFigure[]) => list.filter((f) => !f.excluded).sort(byPosition)[0]?.n;
    if (first(before) !== first(figures)) vault.invalidateCover(req.params.id);
    res.json(figures);
  });

  // Covers ------------------------------------------------------------------

  /** The browser draws what this says. Generation waits for an answer, so one tab asks one paper at a time. */
  api.get('/papers/:id/cover', async (req, res) => {
    const paperId = req.params.id;
    const paper = vault.getPaper(paperId);
    if (!paper.coverStale) {
      res.json({ settled: true, thumbStamp: paper.thumbStamp } satisfies CoverPlan);
      return;
    }
    // A damaged figures.json only costs this paper its crop.
    const figures = await Promise.resolve()
      .then(() => figuresOf(paperId))
      .catch(() => [] as PaperFigure[]);
    const choice = await chooseCover(
      figures,
      (file) => existsSync(join(vault.figuresDir(paperId), file)),
      () => inTurn(() => locateFirstFigurePage(new Uint8Array(readFileSync(vault.pdfPath(paperId))))),
    );
    res.json({ settled: false, ...choice } satisfies CoverPlan);
  });
  api.post('/papers/:id/cover/failed', (req, res) => {
    vault.getPaper(req.params.id);
    vault.settleCoverAsFailed(req.params.id);
    res.json({ ok: true });
  });

  /** What generation is based on, for a paper or a collection. */
  const validateOwner = (ownerId: string) => {
    if (!isCollectionId(ownerId)) return paperContext(ownerId).meta.title;
    const collection = vault.getCollection(ownerId);
    if (!collection.papers.some((p) => p.textChars >= 50)) throw new BadRequest(t('合集里没有可提取文字的论文'));
    return collection.title;
  };

  const buildSource = async (ownerId: string, mode: CollectionMode, withFigures: boolean) => {
    if (!isCollectionId(ownerId)) {
      const { meta, text, truncated } = paperContext(ownerId);
      const figures: SourceFigure[] = withFigures
        ? (await figuresOf(ownerId))
            .filter((f) => !f.excluded)
            .map((f) => ({ path: figurePath(false, ownerId, f.file), label: f.label, caption: f.caption, page: f.page }))
        : [];
      return { source: paperSource(meta, text, truncated, figures), paperIds: undefined };
    }
    const papers = vault.getCollection(ownerId).papers.filter((p) => p.textChars >= 50);
    const budget = Math.floor(MAX_PAPER_CHARS / papers.length);
    const parts = papers.map((meta) => ({ meta, ...pageMarkedText(vault.readPages(meta.id), budget) }));
    const figures: SourceFigure[] = [];
    if (withFigures) {
      for (const [i, paper] of papers.entries()) {
        for (const f of await figuresOf(paper.id)) {
          if (!f.excluded) {
            figures.push({ path: figurePath(true, paper.id, f.file), label: f.label, caption: f.caption, page: f.page, paperN: i + 1 });
          }
        }
      }
    }
    return { source: collectionSource(parts, mode, figures), paperIds: papers.map((p) => p.id) };
  };

  // Collections -------------------------------------------------------------

  api.get('/collections', (_req, res) => res.json(vault.listCollections()));
  api.post('/collections', json, (req, res) => {
    const { title, paperIds } = req.body as { title?: string; paperIds?: string[] };
    if (!Array.isArray(paperIds) || paperIds.length < 2) throw new BadRequest(t('合集至少需要两篇论文'));
    if (paperIds.length > MAX_COLLECTION_PAPERS) throw new BadRequest(t('合集最多 {count} 篇论文', { count: MAX_COLLECTION_PAPERS }));
    const collection = vault.createCollection(title?.trim() || t('未命名合集'), paperIds);
    jobs.send({ type: 'library' });
    res.json(collection);
  });
  api.get('/collections/:id', (req, res) => res.json(vault.getCollection(req.params.id)));
  api.patch('/collections/:id', json, (req, res) => {
    const { title, paperIds } = req.body as { title?: string; paperIds?: string[] };
    if (paperIds && paperIds.length > MAX_COLLECTION_PAPERS) throw new BadRequest(t('合集最多 {count} 篇论文', { count: MAX_COLLECTION_PAPERS }));
    const collection = vault.updateCollection(req.params.id, {
      ...(title !== undefined ? { title: title.trim() || t('未命名合集') } : {}),
      ...(paperIds ? { paperIds } : {}),
    });
    jobs.send({ type: 'library' });
    res.json(collection);
  });
  api.delete('/collections/:id', (req, res) => {
    const running = jobs.list().some((j) => j.paperId === req.params.id && j.status === 'running');
    if (running) throw new BadRequest(t('这个合集还有任务在运行'));
    vault.trashCollection(req.params.id);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });

  // Blogs -------------------------------------------------------------------

  api.get('/papers/:id/blogs', (req, res) => res.json(vault.listBlogs(req.params.id)));
  api.get('/papers/:id/blogs/:blogId', (req, res) => res.json(vault.getBlog(req.params.id, req.params.blogId)));

  api.post('/papers/:id/blogs', json, (req, res) => res.json(startBlog(req.params.id, req.body ?? {})));

  function startBlog(paperId: string, body: Record<string, any>) {
    const defaults = config.get().blog;
    const { style = defaults.style, language = defaults.language, instructions, mode = 'digest' } = body;
    const customStyle = body.customStyle ?? defaults.customStyle;
    const withFigures = body.figures !== false;
    const title = validateOwner(paperId);
    const agent = agentChoice(body);
    const blogId = newOutputId();
    const job = jobs.start({ kind: 'blog', paperId, label: t('博客：{title}', { title }), targetId: blogId }, async ({ signal, delta, progress }) => {
      if (withFigures) progress({ done: 0, note: t('正在提取论文图表') });
      const { source, paperIds } = await buildSource(paperId, mode, withFigures);
      progress({ done: 0, note: t('正在写作') });
      const raw = await runAgent({
        ...agent,
        ...blogPrompt({ source, style, customStyle, language, instructions }),
        onDelta: delta,
        signal,
      });
      const markdown = keepKnownFigures(raw, new Set(source.figures.map((f) => f.path)));
      const now = new Date().toISOString();
      vault.saveBlog(paperId, {
        id: blogId,
        title: markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? title,
        style,
        language,
        agent: agentLabel(agent),
        sources: paperIds,
        mode: paperIds ? mode : undefined,
        createdAt: now,
        updatedAt: now,
        markdown,
        chars: markdown.length,
      });
    });
    return { job, blogId };
  }

  /** A single Markdown file with its figures embedded, ready to publish elsewhere. */
  api.get('/papers/:id/blogs/:blogId/export', (req, res) => {
    const blog = vault.getBlog(req.params.id, req.params.blogId);
    const blogsDir = join(vault.ownerDir(req.params.id), 'blogs');
    const markdown = inlineFigures(blog.markdown, (relative) => {
      const file = resolvePath(blogsDir, relative);
      return file.startsWith(`${vault.root}/`) && existsSync(file) ? readFileSync(file) : null;
    });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(blog.title)}.md`);
    res.send(markdown);
  });

  api.put('/papers/:id/blogs/:blogId', json, (req, res) => {
    const current = vault.getBlog(req.params.id, req.params.blogId);
    const markdown = String(req.body.markdown ?? current.markdown);
    const next: Blog = {
      ...current,
      title: markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? current.title,
      markdown,
      updatedAt: new Date().toISOString(),
    };
    vault.saveBlog(req.params.id, next);
    jobs.send({ type: 'library' });
    res.json(vault.getBlog(req.params.id, req.params.blogId));
  });

  api.delete('/papers/:id/blogs/:blogId', (req, res) => {
    vault.trashBlog(req.params.id, req.params.blogId);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });

  // Podcasts ----------------------------------------------------------------

  /** A podcast left `synthesizing` with no live job means the server stopped mid-run. */
  const withLive = (podcast: Podcast): Podcast =>
    podcast.status === 'synthesizing' && !jobs.isActive(podcast.id)
      ? { ...podcast, status: 'failed', error: podcast.error ?? t('合成被中断，可以重新合成。') }
      : podcast;
  const withLiveStatus = <T extends { kind: string; id: string; status?: string }>(entries: T[]): T[] =>
    entries.map((e) => (e.kind === 'podcast' && e.status === 'synthesizing' && !jobs.isActive(e.id) ? { ...e, status: 'failed' } : e));

  api.get('/papers/:id/podcasts', (req, res) => res.json(vault.listPodcasts(req.params.id).map(withLive)));
  api.get('/papers/:id/podcasts/:podcastId', (req, res) =>
    res.json(withLive(vault.getPodcast(req.params.id, req.params.podcastId))),
  );

  api.post('/papers/:id/podcasts', json, (req, res) => res.json(startPodcast(req.params.id, req.body ?? {})));

  function startPodcast(paperId: string, body: Record<string, any>) {
    const defaults = config.get().podcast;
    const options = {
      style: body.style ?? defaults.style,
      customStyle: body.customStyle ?? defaults.customStyle,
      language: body.language ?? defaults.language,
      length: body.length ?? defaults.length,
      engine: body.engine ?? defaults.engine,
      speakers: (body.speakers ?? defaults.speakers) as [string, string],
      instructions: body.instructions as string | undefined,
      autoSynthesize: Boolean(body.autoSynthesize),
      mode: (body.mode ?? 'digest') as CollectionMode,
    };
    const ownerTitle = validateOwner(paperId);
    const collection = isCollectionId(paperId);
    // Doubao takes one block of text and can't weave several papers together.
    if (collection) options.engine = 'agent';
    const now = new Date().toISOString();
    const base: Podcast = {
      id: newOutputId(),
      title: ownerTitle,
      status: 'draft',
      mode: collection ? options.mode : undefined,
      engine: options.engine,
      language: options.language,
      // Direct generation ignores style, so an episode shouldn't claim one.
      style: options.engine === 'doubao' ? '' : options.style,
      speakers: options.speakers,
      speechRate: defaults.speechRate,
      headMusic: defaults.headMusic,
      tailMusic: defaults.tailMusic,
      rounds: [],
      createdAt: now,
      updatedAt: now,
    };

    if (options.engine === 'doubao') {
      requireApiKey();
      const inputText = vault.readPages(paperId).join('\n\n').slice(0, MAX_DIRECT_INPUT);
      const podcast: Podcast = { ...base, status: 'synthesizing' };
      vault.savePodcast(paperId, podcast);
      const job = startSynthesis(paperId, podcast, {
        action: 0,
        input_text: inputText,
        input_info: { input_text_max_length: MAX_DIRECT_INPUT },
      });
      return { job, podcastId: podcast.id };
    }

    const agent = agentChoice(body);
    const podcast: Podcast = { ...base, agent: agentLabel(agent) };
    const job = jobs.start(
      { kind: 'script', paperId, label: t('脚本：{title}', { title: ownerTitle }), targetId: podcast.id },
      async ({ signal, delta }) => {
        const { source } = await buildSource(paperId, options.mode, false);
        const raw = await runAgent({
          ...agent,
          ...scriptPrompt({ ...options, source }),
          onDelta: delta,
          signal,
        });
        const { title, rounds } = parseScript(raw);
        if (rounds.length < 2) throw new Error(t('Agent 返回的内容无法解析成对话脚本，请重试或更换后端。'));
        const draft: Podcast = { ...podcast, title: title || podcast.title, rounds, updatedAt: new Date().toISOString() };
        vault.savePodcast(paperId, draft);
        if (options.autoSynthesize && config.apiKey() && scriptIssue(draft.rounds) === null) {
          startSynthesis(paperId, draft, scriptPayload(draft));
        }
      },
    );
    return { job, podcastId: podcast.id };
  }

  /** Why a script cannot be sent to Doubao, or null when it can. */
  const scriptIssue = (rounds: ScriptRound[]): string | null => {
    if (!rounds.length) return t('脚本为空');
    const long = rounds.findIndex((r) => r.text.length > MAX_ROUND_CHARS);
    if (long >= 0) return t('第 {round} 轮超过 {limit} 字符', { round: long + 1, limit: MAX_ROUND_CHARS });
    const total = rounds.reduce((n, r) => n + r.text.length, 0);
    if (total > MAX_SCRIPT_CHARS) return t('脚本共 {total} 字符，超过上限 {limit}', { total, limit: MAX_SCRIPT_CHARS });
    return null;
  };

  const scriptPayload = (podcast: Podcast) => ({
    action: 3,
    nlp_texts: podcast.rounds.map((r) => ({ speaker: podcast.speakers[r.speaker], text: r.text })),
  });

  const requireApiKey = () => {
    if (!config.apiKey()) throw new BadRequest(t('请先在设置中配置豆包语音 API Key'));
  };

  function startSynthesis(paperId: string, podcast: Podcast, input: Record<string, unknown>) {
    const final = vault.audioPath(paperId, podcast.id);
    const partial = `${final}.part`;
    const total = podcast.rounds.length || undefined;
    const synthesizing: Podcast = { ...podcast, status: 'synthesizing', error: undefined, updatedAt: new Date().toISOString() };
    vault.savePodcast(paperId, synthesizing);
    return jobs.start(
      { kind: 'synth', paperId, label: t('合成：{title}', { title: podcast.title }), targetId: podcast.id },
      async ({ signal, progress }) => {
        mkdirSync(dirname(final), { recursive: true });
        const out = createWriteStream(partial);
        let done = 0;
        progress({ done: 0, total, note: t('正在连接豆包语音') });
        try {
          const settings = config.get();
          const result = await synthesizePodcast({
            apiKey: config.apiKey(),
            resourceId: settings.doubao.resourceId,
            signal,
            payload: {
              ...input,
              use_head_music: podcast.headMusic,
              use_tail_music: podcast.tailMusic,
              audio_config: { format: 'mp3', sample_rate: 24000, speech_rate: podcast.speechRate },
              speaker_info: { random_order: false, speakers: podcast.speakers },
            },
            onAudio: (chunk) => out.write(chunk),
            onRound: (round) => {
              if (round.roundId >= 0 && round.roundId < 9999) done++;
              progress({
                done,
                total,
                note: round.roundId < 0 ? t('片头音乐') : round.roundId >= 9999 ? t('片尾音乐') : t('第 {round} 轮', { round: done }),
              });
            },
          });
          await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
          renameSync(partial, final);
          const speech = result.rounds.filter((r) => r.roundId >= 0 && r.roundId < 9999 && r.text);
          vault.savePodcast(paperId, {
            ...synthesizing,
            status: 'ready',
            rounds: speech.map((r) => ({
              speaker: r.speaker === podcast.speakers[1] ? 1 : 0,
              text: r.text,
              start: r.start,
              end: r.end,
            })),
            duration: result.duration,
            audioBytes: statSync(final).size,
            usage: result.usage,
            inputTruncated: result.inputTruncated,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          out.destroy();
          rmSync(partial, { force: true });
          throw err;
        }
      },
      (message, canceled) => {
        vault.savePodcast(paperId, {
          ...synthesizing,
          status: 'failed',
          error: canceled ? t('已取消') : message,
          updatedAt: new Date().toISOString(),
        });
      },
    );
  }

  api.put('/papers/:id/podcasts/:podcastId', json, (req, res) => {
    const current = vault.getPodcast(req.params.id, req.params.podcastId);
    if (jobs.isActive(current.id)) throw new BadRequest(t('正在合成中，请等待完成后再修改'));
    const { title, rounds, speakers, speechRate, headMusic, tailMusic } = req.body as Partial<Podcast>;
    const next: Podcast = { ...current, updatedAt: new Date().toISOString() };
    if (title !== undefined) next.title = title;
    if (speakers) next.speakers = speakers;
    if (speechRate !== undefined) next.speechRate = speechRate;
    if (headMusic !== undefined) next.headMusic = headMusic;
    if (tailMusic !== undefined) next.tailMusic = tailMusic;
    if (rounds) {
      next.rounds = rounds.map((r) => ({ speaker: r.speaker === 1 ? 1 : 0, text: String(r.text) }));
      // The audio no longer matches an edited script, so the transcript goes back to draft.
      if (current.status !== 'synthesizing') {
        next.status = 'draft';
        next.duration = undefined;
        next.error = undefined;
      }
    }
    vault.savePodcast(req.params.id, next);
    jobs.send({ type: 'library' });
    res.json(next);
  });

  api.post('/papers/:id/podcasts/:podcastId/synthesize', (req, res) => {
    res.json({ job: synthesizeScript(req.params.id, req.params.podcastId) });
  });

  function synthesizeScript(ownerId: string, podcastId: string) {
    requireApiKey();
    const podcast = vault.getPodcast(ownerId, podcastId);
    if (jobs.isActive(podcast.id)) throw new BadRequest(t('这期播客正在处理中'));
    const issue = scriptIssue(podcast.rounds);
    if (issue) throw new BadRequest(issue);
    return startSynthesis(ownerId, podcast, scriptPayload(podcast));
  }

  api.delete('/papers/:id/podcasts/:podcastId', (req, res) => {
    if (jobs.isActive(req.params.podcastId)) throw new BadRequest(t('正在处理中，请先取消任务'));
    vault.trashPodcast(req.params.id, req.params.podcastId);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });

  api.get('/papers/:id/podcasts/:podcastId/audio', (req, res) => {
    const file = vault.audioPath(req.params.id, req.params.podcastId);
    if (req.query.download) {
      const title = vault.getPodcast(req.params.id, req.params.podcastId).title;
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.mp3`);
    }
    sendFile(res, file, 'audio/mpeg');
  });

  // Linked repositories -----------------------------------------------------

  /** Reading a PDF's link annotations takes a moment, so it's done once. Requests in the meantime share it. */
  const readingLinks = new Map<string, Promise<PdfLink[]>>();

  const repoLinksOf = (paperId: string): Promise<PdfLink[]> => {
    const cached = vault.readRepoLinks(paperId, REPO_LINKS_VERSION);
    if (cached) return Promise.resolve(cached);
    const running = readingLinks.get(paperId);
    if (running) return running;
    const owner = vault;
    // Parsing a whole PDF holds up this thread, so it waits its turn with the other heavy PDF work.
    const work = inTurn(() => readPdfLinks(new Uint8Array(readFileSync(owner.pdfPath(paperId)))))
      .then((links) => {
        owner.writeRepoLinks(paperId, REPO_LINKS_VERSION, links);
        return links;
      })
      // A PDF that can't be read that way still has its text, so this isn't worth an error.
      .catch((err: Error) => {
        console.error(err);
        return [];
      })
      .finally(() => readingLinks.delete(paperId));
    readingLinks.set(paperId, work);
    return work;
  };

  const repoJobId = (paperId: string) => `repo-${paperId}`;

  /** Whichever commits of this repository papers in this vault still point at. */
  const releaseClones = (repo: { owner: string; name: string }) => {
    const same = (p: PaperSummary) => p.repo?.owner.toLowerCase() === repo.owner.toLowerCase() && p.repo?.name.toLowerCase() === repo.name.toLowerCase();
    repos.release(repo, vault.listPapers().filter(same).map((p) => p.repo!.sha));
  };

  /** A clone can be missing, as on a new machine. Returns why it couldn't be restored, if it couldn't. */
  const ensureClone = async (repo: PaperRepo, job: JobContext): Promise<string | undefined> => {
    if (repos.has(repo)) return undefined;
    job.progress({ done: 0, note: t('正在重新拉取 {repo}', { repo: repoLabel(repo) }) });
    try {
      await repos.restore(repo, { signal: job.signal });
      return undefined;
    } catch (err) {
      job.signal.throwIfAborted();
      return t('没能重新拉取 {repo} @ {sha}（{error}）。这次回答只依据论文。', { repo: repoLabel(repo), sha: shortSha(repo.sha), error: (err as Error).message });
    }
  };

  const chatRunning = (paperId: string) => jobs.list().some((j) => j.kind === 'chat' && j.paperId === paperId && j.status === 'running');

  /** Detecting only reads what's already on disk. Nothing touches the network until a link is asked for. */
  api.get('/papers/:id/repo', async (req, res) => {
    const paper = vault.getPaper(req.params.id);
    const state: RepoState = {
      link: paper.repo,
      candidates: rankRepoCandidates({ title: paper.title, pages: vault.readPages(paper.id), links: await repoLinksOf(paper.id) }),
    };
    res.json(state);
  });

  /** Links a repository, or fetches a newer commit of the one already linked. */
  api.post('/papers/:id/repo', json, (req, res) => {
    const paperId = req.params.id;
    vault.getPaper(paperId);
    const parsed = parseRepoUrl(req.body?.url);
    if (!parsed) throw new BadRequest(t('请输入这样的地址：https://github.com/<owner>/<repo>'));
    if (jobs.isActive(repoJobId(paperId))) throw new BadRequest(t('正在关联仓库，请等它结束'));
    if (chatRunning(paperId)) throw new BadRequest(t('这个会话正在回答，请等它结束'));
    const label = repoLabel(parsed);
    res.json(
      jobs.start({ kind: 'repo', paperId, targetId: repoJobId(paperId), label: t('关联仓库：{repo}', { repo: label }) }, async (job) => {
        job.progress({ done: 0, note: t('正在拉取 {repo}', { repo: label }) });
        const pinned = await repos.clone(parsed, {
          signal: job.signal,
          onProgress: (percent) => job.progress({ done: percent, total: 100, note: t('正在拉取 {repo}', { repo: label }) }),
        });
        job.signal.throwIfAborted();
        const previous = vault.getPaper(paperId).repo;
        // Fetching a newer commit leaves the switch alone, while picking a repository means wanting to use it.
        const same = previous && repoLabel(previous).toLowerCase() === label.toLowerCase();
        vault.setPaperRepo(paperId, { ...pinned, enabled: same ? previous.enabled : true });
        // A chat asked in the meantime may still be reading the old one.
        if (previous && !chatRunning(paperId)) releaseClones(previous);
      }),
    );
  });

  api.patch('/papers/:id/repo', json, (req, res) => {
    const link = vault.getPaper(req.params.id).repo;
    if (!link) throw new NotFound(t('这篇论文还没有关联仓库'));
    if (typeof req.body?.enabled !== 'boolean') throw new BadRequest(t('请求无效'));
    res.json(vault.setPaperRepo(req.params.id, { ...link, enabled: req.body.enabled }));
    jobs.send({ type: 'library' });
  });

  api.delete('/papers/:id/repo', (req, res) => {
    const link = vault.getPaper(req.params.id).repo;
    if (chatRunning(req.params.id)) throw new BadRequest(t('这个会话正在回答，请等它结束'));
    if (link) {
      vault.setPaperRepo(req.params.id, undefined);
      releaseClones(link);
    }
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });

  // Chat --------------------------------------------------------------------

  const askInSession = (
    paperId: string,
    sessionId: string,
    history: ChatMessage[],
    harness: AgentBackend,
    model: string,
    thinking: string,
    body: { message: string; selection?: string; page?: number },
  ) => {
    const ctx = paperContext(paperId);
    const agent = { backend: harness, model, thinking };
    const user: ChatMessage = {
      role: 'user',
      content: body.message.trim(),
      selection: body.selection,
      page: body.page,
      at: new Date().toISOString(),
    };
    vault.appendChat(paperId, sessionId, user);
    const finish = (content: string, error?: boolean, suggestions?: string[], extra?: Pick<ChatMessage, 'repo' | 'filesRead' | 'notice'>) =>
      vault.appendChat(paperId, sessionId, {
        role: 'assistant',
        content,
        error,
        suggestions: suggestions?.length ? suggestions : undefined,
        agent: agentLabel(agent),
        ...extra,
        at: new Date().toISOString(),
      });
    const question = { ...ctx, history, question: user.content, selection: body.selection, page: body.page };
    // With no repository in use, a question is one call and nothing here mentions tools.
    const repo = ctx.meta.repo?.enabled ? ctx.meta.repo : undefined;
    const job = jobs.start(
      { kind: 'chat', paperId, targetId: sessionId, label: t('问答：{title}', { title: user.content.slice(0, 40) }), ...(repo ? { tools: true } : {}) },
      async (work) => {
        const { signal, delta } = work;
        let notice: string | undefined;
        if (repo) {
          notice = await ensureClone(repo, work);
          if (!notice) {
            const pinned: RepoRef = { owner: repo.owner, name: repo.name, sha: repo.sha };
            const answer = await answerWithRepo({ ...question, repo: pinned }, { runAgent, agent, reader: repos.reader(pinned), ctx: work });
            finish(answer.text, undefined, answer.suggestions, { repo: pinned, filesRead: answer.filesRead.length ? answer.filesRead : undefined });
            return;
          }
        }
        const reply = await runAgent({ ...agent, ...chatPrompt(question), onDelta: delta, signal });
        // The prompt quotes the paper, so only the reply itself may be read for suggestions.
        const { text, suggestions } = parseAnswer(reply);
        if (!text) throw new Error(t('{agent} 没有返回内容。{detail}', { agent: harness, detail: '' }));
        finish(text, undefined, suggestions, notice ? { notice } : undefined);
      },
      (error, canceled) => finish(canceled ? t('已取消') : error, true),
    );
    jobs.send({ type: 'library' });
    return { job, message: user };
  };

  api.get('/papers/:id/chats', (req, res) => res.json(vault.listChats(req.params.id, config.get().agent.backend)));
  api.get('/papers/:id/chats/:sessionId', (req, res) => res.json(vault.getChat(req.params.id, req.params.sessionId)));

  /** A session is created by its first question, so an empty one never lingers in the history. */
  api.post('/papers/:id/chats', json, (req, res) => {
    if (!req.body?.message?.trim()) throw new BadRequest(t('问题不能为空'));
    paperContext(req.params.id);
    const harness = (req.body.harness ?? config.get().agent.backend) as AgentBackend;
    if (!AGENT_BACKENDS.includes(harness)) throw new BadRequest(t('未知的 Agent 后端：{backend}', { backend: String(harness) }));
    const model = String(req.body.model ?? '');
    const thinking = String(req.body.thinking ?? '');
    const session = vault.createChat(req.params.id, req.body.message, harness, model, thinking);
    res.json({ sessionId: session.id, ...askInSession(req.params.id, session.id, [], harness, model, thinking, req.body) });
  });

  api.post('/papers/:id/chats/:sessionId/messages', json, (req, res) => {
    if (!req.body?.message?.trim()) throw new BadRequest(t('问题不能为空'));
    const session = vault.getChat(req.params.id, req.params.sessionId);
    if (jobs.isActive(session.id)) throw new BadRequest(t('这个会话正在回答，请等它结束'));
    res.json(askInSession(req.params.id, session.id, session.messages, session.harness, session.model, session.thinking, req.body));
  });

  /** The model and thinking level can change at any time. The harness can't, so it isn't accepted here. */
  api.patch('/papers/:id/chats/:sessionId', json, (req, res) => {
    const { model, thinking } = req.body ?? {};
    res.json(
      vault.updateChat(req.params.id, req.params.sessionId, {
        ...(model !== undefined ? { model: String(model) } : {}),
        ...(thinking !== undefined ? { thinking: String(thinking) } : {}),
      }),
    );
  });

  api.delete('/papers/:id/chats/:sessionId', (req, res) => {
    if (jobs.isActive(req.params.sessionId)) throw new BadRequest(t('这个会话正在回答，请等它结束'));
    vault.trashChat(req.params.id, req.params.sessionId);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });

  // Assistant ---------------------------------------------------------------

  const assistant = new Assistant({
    vault: () => vault,
    jobs,
    settings: () => config.get(),
    hasVoiceKey: () => Boolean(config.apiKey()),
    runAgent,
    searchArxiv,
    lookupArxiv,
    importArxiv,
    startBlog,
    startPodcast,
    synthesize: synthesizeScript,
  });

  const harnessOf = (value: unknown): AgentBackend => {
    const harness = (value ?? config.get().agent.backend) as AgentBackend;
    if (!AGENT_BACKENDS.includes(harness)) throw new BadRequest(t('未知的 Agent 后端：{backend}', { backend: String(harness) }));
    return harness;
  };

  api.get('/assistant/sessions', (_req, res) => res.json(assistant.list()));
  api.get('/assistant/sessions/:id', (req, res) => res.json(assistant.get(req.params.id)));
  api.post('/assistant/sessions', json, (req, res) => {
    const { message, harness, model, thinking } = req.body ?? {};
    res.json(assistant.create(String(message ?? ''), harnessOf(harness), String(model ?? ''), String(thinking ?? '')));
  });
  api.post('/assistant/sessions/:id/messages', json, (req, res) => {
    res.json(assistant.send(req.params.id, String(req.body?.message ?? '')));
  });
  const idList = (value: unknown): string[] => {
    if (value !== undefined && !Array.isArray(value)) throw new BadRequest(t('请求无效'));
    return (value ?? []).map(String);
  };
  api.post('/assistant/sessions/:id/decide', json, (req, res) => {
    const { approve, reject, allowReads } = req.body ?? {};
    res.json(assistant.decide(req.params.id, { approve: idList(approve), reject: idList(reject), allowReads: allowReads === true }));
  });
  api.post('/assistant/sessions/:id/retry', json, (req, res) => {
    res.json(assistant.retry(req.params.id, idList(req.body?.actions)));
  });
  api.patch('/assistant/sessions/:id/actions/:actionId', json, (req, res) => {
    res.json(assistant.editAction(req.params.id, req.params.actionId, req.body ?? {}));
  });
  api.patch('/assistant/sessions/:id', json, (req, res) => {
    const { model, thinking } = req.body ?? {};
    res.json(
      assistant.update(req.params.id, {
        ...(model !== undefined ? { model: String(model) } : {}),
        ...(thinking !== undefined ? { thinking: String(thinking) } : {}),
      }),
    );
  });
  api.delete('/assistant/sessions/:id', (req, res) => {
    assistant.remove(req.params.id);
    res.json({ ok: true });
  });

  // Jobs and events ---------------------------------------------------------

  api.get('/jobs', (_req, res) => res.json(jobs.list()));
  api.post('/jobs/:id/cancel', (req, res) => res.json({ ok: jobs.cancel(req.params.id) }));

  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const listener = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    jobs.on('event', listener);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      jobs.off('event', listener);
    });
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: t('接口不存在') });
  });

  // pdf.js loads its worker, character maps and fonts at runtime.
  app.use('/pdfjs', express.static(PDFJS_DIR, { maxAge: '1d', index: false }));

  const web = webRoot();
  if (web) {
    app.use(express.static(web, { index: 'index.html' }));
    app.use((_req, res) => res.sendFile('index.html', { root: web }));
  }

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof NotFound ? 404 : err instanceof BadRequest ? 400 : err instanceof DoubaoError ? 502 : (err.status ?? 500);
    const message = err.type === 'entity.too.large' ? t('文件太大') : err.message;
    if (status >= 500) console.error(err);
    if (res.headersSent) res.end();
    else res.status(status).json({ error: message });
  });

  return { app, jobs, getVault: () => vault };
}

function sendFile(res: Response, path: string, type: string): void {
  if (!existsSync(path)) {
    res.status(404).json({ error: t('文件不存在') });
    return;
  }
  // `sendFile` handles Range requests, which audio seeking and pdf.js both rely on.
  res.sendFile(path, { headers: { 'Content-Type': type }, dotfiles: 'allow', acceptRanges: true, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
}

function revealInFileManager(path: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [path]]
      : process.platform === 'win32'
        ? ['explorer', [path]]
        : ['xdg-open', [path]];
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref();
}

export function listen(app: express.Express, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const attempt = (candidate: number, remaining: number) => {
      // Loopback only: this server is never meant to be reachable from the network.
      const server = app.listen(candidate, '127.0.0.1');
      server.once('listening', () => resolve({ server, port: candidate }));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) attempt(candidate + 1, remaining - 1);
        else reject(err);
      });
    };
    attempt(port, 10);
  });
}
