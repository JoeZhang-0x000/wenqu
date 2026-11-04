import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { setLocale, t } from '../shared/i18n.js';
import {
  AGENT_BACKENDS,
  MAX_ROUND_CHARS,
  MAX_SCRIPT_CHARS,
  isCollectionId,
  type AgentBackend,
  type Blog,
  type ChatMessage,
  type CollectionMode,
  type PaperFigure,
  type Podcast,
  type ScriptRound,
  type ServerEvent,
  type SettingsPatch,
} from '../shared/types.js';
import { runAgent } from './agents.js';
import { detectAgents } from './harness.js';
import { importArxiv, lookupArxiv } from './arxiv.js';
import { Config, expandHome } from './config.js';
import { DoubaoError, synthesizePodcast } from './doubao.js';
import { FIGURES_VERSION, extractFigures, figurePath, figuresSupported, inlineFigures, keepKnownFigures } from './figures.js';
import { Jobs } from './jobs.js';
import { PDFJS_DIR, pageMarkedText } from './pdf.js';
import { blogPrompt, chatPrompt, collectionSource, paperSource, scriptPrompt, type SourceFigure } from './prompts.js';
import { parseScript } from './script.js';
import { NotFound, Vault, newOutputId } from './vault.js';

/** Enough for almost any paper while keeping the agent call responsive. */
const MAX_PAPER_CHARS = 150_000;
/** Doubao's documented `input_text` range for direct generation. */
const MAX_DIRECT_INPUT = 20_000;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_COLLECTION_PAPERS = 12;
const MAX_ARXIV_LOOKUP = 50;

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
}

export function createApp({ config, devOrigin }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const jobs = new Jobs();
  let vault = new Vault(config.get().vaultPath);

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
    res.json({ paper: vault.getPaper(meta.id), duplicate });
  });

  api.get('/papers/:id', (req, res) => res.json(vault.getPaper(req.params.id)));
  api.patch('/papers/:id', json, (req, res) => {
    const { title, authors, year, abstract } = req.body;
    const patch = Object.fromEntries(
      Object.entries({ title, authors, year, abstract }).filter(([, v]) => v !== undefined),
    );
    const paper = vault.updatePaper(req.params.id, patch);
    jobs.send({ type: 'library' });
    res.json(paper);
  });
  api.delete('/papers/:id', (req, res) => {
    vault.trashPaper(req.params.id);
    jobs.send({ type: 'library' });
    res.json({ ok: true });
  });
  api.get('/papers/:id/pdf', (req, res) => sendFile(res, vault.pdfPath(req.params.id), 'application/pdf'));
  api.get('/papers/:id/thumb', (req, res) => sendFile(res, vault.thumbPath(req.params.id), 'image/jpeg'));
  api.put('/papers/:id/thumb', express.raw({ type: () => true, limit: '4mb' }), (req, res) => {
    vault.getPaper(req.params.id);
    writeFileSync(vault.thumbPath(req.params.id), req.body as Buffer);
    res.json({ ok: true });
  });
  api.post('/papers/:id/reveal', (req, res) => {
    vault.getPaper(req.params.id);
    revealInFileManager(vault.paperDir(req.params.id));
    res.json({ ok: true });
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

  /** Two requests for the same paper share one extraction. */
  const extracting = new Map<string, Promise<PaperFigure[]>>();

  const figuresOf = (paperId: string): Promise<PaperFigure[]> => {
    const cached = vault.readFigures(paperId, FIGURES_VERSION);
    if (cached) return Promise.resolve(cached);
    const running = extracting.get(paperId);
    if (running) return running;
    const work = (async () => {
      if (!(await figuresSupported())) return [];
      const dir = vault.figuresDir(paperId);
      rmSync(dir, { recursive: true, force: true });
      const figures = await extractFigures(new Uint8Array(readFileSync(vault.pdfPath(paperId))), dir);
      vault.writeFigures(paperId, FIGURES_VERSION, figures);
      return figures;
    })()
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
    const figures = (await figuresOf(req.params.id)).map((f) =>
      f.n === req.params.n ? { ...f, excluded: Boolean(req.body?.excluded) } : f,
    );
    vault.writeFigures(req.params.id, FIGURES_VERSION, figures);
    res.json(figures);
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

  api.post('/papers/:id/blogs', json, (req, res) => {
    const paperId = req.params.id;
    const defaults = config.get().blog;
    const { style = defaults.style, language = defaults.language, instructions, mode = 'digest' } = req.body ?? {};
    const customStyle = req.body?.customStyle ?? defaults.customStyle;
    const withFigures = req.body?.figures !== false;
    const title = validateOwner(paperId);
    const agent = agentChoice(req.body ?? {});
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
    res.json({ job, blogId });
  });

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

  api.post('/papers/:id/podcasts', json, (req, res) => {
    const paperId = req.params.id;
    const defaults = config.get().podcast;
    const body = req.body ?? {};
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
      res.json({ job, podcastId: podcast.id });
      return;
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
    res.json({ job, podcastId: podcast.id });
  });

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
    requireApiKey();
    const podcast = vault.getPodcast(req.params.id, req.params.podcastId);
    if (jobs.isActive(podcast.id)) throw new BadRequest(t('这期播客正在处理中'));
    const issue = scriptIssue(podcast.rounds);
    if (issue) throw new BadRequest(issue);
    res.json({ job: startSynthesis(req.params.id, podcast, scriptPayload(podcast)) });
  });

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
    const finish = (content: string, error?: boolean) =>
      vault.appendChat(paperId, sessionId, { role: 'assistant', content, error, agent: agentLabel(agent), at: new Date().toISOString() });
    const job = jobs.start(
      { kind: 'chat', paperId, targetId: sessionId, label: t('问答：{title}', { title: user.content.slice(0, 40) }) },
      async ({ signal, delta }) => {
        const reply = await runAgent({
          ...agent,
          ...chatPrompt({ ...ctx, history, question: user.content, selection: body.selection, page: body.page }),
          onDelta: delta,
          signal,
        });
        finish(reply);
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

class BadRequest extends Error {}

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
