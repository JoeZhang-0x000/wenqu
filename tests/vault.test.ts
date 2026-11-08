import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPdf, pageMarkedText } from '../src/server/pdf';
import { BadRequest, NotFound, Vault, newOutputId } from '../src/server/vault';
import { MAX_PAPER_TAGS, MAX_TAG_CHARS, changeTags, normalizeTags } from '../src/shared/types';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

describe('extractPdf', () => {
  it('reads the title, authors, abstract and year of a paper', async () => {
    const result = await extractPdf(new Uint8Array(fixture('cpn.pdf')));
    expect(result.title).toBe('Cascade Pruning Networks: Learning When to Stop Re-ranking');
    expect(result.authors).toEqual(['Lin Zhao', 'Maria Keller', 'Tomasz Nowak']);
    expect(result.abstract).toContain('Neural re-rankers');
    expect(result.year).toBe(2025);
    expect(result.pages).toHaveLength(6);
    expect(result.pages.join('\n')).toContain('182 ms');
  });

  it('extracts CJK text that depends on predefined character maps', async () => {
    const result = await extractPdf(new Uint8Array(fixture('cpn-zh.pdf')));
    expect(result.pages[0]).toContain('基于级联剪枝');
    expect(result.title).toBe('基于级联剪枝的重排序加速方法研究');
  });
});

describe('tags', () => {
  let root: string;
  let vault: Vault;
  let first: string;
  let second: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wenqu-tags-'));
    vault = new Vault(root);
    first = (await vault.importPdf(fixture('cpn.pdf'), 'cpn.pdf')).meta.id;
    second = (await vault.importPdf(fixture('cpn-zh.pdf'), 'cpn-zh.pdf')).meta.id;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('tidies what it is given', () => {
    expect(normalizeTags(['  #NLP ', 'nlp', 'a  b', '', 7, 'x'.repeat(MAX_TAG_CHARS + 1)])).toEqual(['NLP', 'a b']);
    expect(normalizeTags('NLP')).toEqual([]);
  });

  it('adds and removes without caring about case', () => {
    expect(changeTags(['NLP', 'CV'], ['RL', 'cv'], ['nlp'])).toEqual(['CV', 'RL']);
  });

  it('treats a paper from before tags existed as having none', () => {
    const file = join(vault.paperDir(first), 'meta.json');
    const { tags: _tags, ...old } = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(old));
    expect(vault.getPaper(first).tags).toEqual([]);
    expect(vault.updatePaper(first, { title: 'Renamed' }).tags).toEqual([]);
  });

  it('uses the spelling already in the library', () => {
    vault.updatePaper(first, { tags: ['LLM'] });
    expect(vault.updatePaper(second, { tags: ['llm', 'pruning'] }).tags).toEqual(['LLM', 'pruning']);
    expect(vault.listTags()).toEqual([{ tag: 'LLM', count: 2 }, { tag: 'pruning', count: 1 }]);
  });

  it('lets the only paper with a tag change how it is spelled', () => {
    vault.updatePaper(first, { tags: ['llm'] });
    expect(vault.updatePaper(first, { tags: ['LLM'] }).tags).toEqual(['LLM']);
  });

  it('keeps what fits when adding, and refuses too many when setting', () => {
    const many = Array.from({ length: MAX_PAPER_TAGS }, (_, i) => `tag ${i}`);
    expect(vault.addTags(first, many).tags).toHaveLength(MAX_PAPER_TAGS);
    expect(vault.addTags(first, ['one more']).tags).toEqual(many);
    expect(() => vault.updatePaper(first, { tags: [...many, 'one more'] })).toThrow(BadRequest);
  });
});

describe('pageMarkedText', () => {
  it('marks pages and truncates at the limit', () => {
    expect(pageMarkedText(['one', 'two'], 1000)).toEqual({ text: '\n[p.1]\none\n\n[p.2]\ntwo\n', truncated: false });
    const cut = pageMarkedText(['x'.repeat(100), 'y'.repeat(100)], 120);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBe(120);
  });
});

describe('Vault', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wenqu-vault-'));
    vault = new Vault(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('imports a PDF and recognises a duplicate by content', async () => {
    const first = await vault.importPdf(fixture('cpn.pdf'), 'a.pdf');
    const second = await vault.importPdf(fixture('cpn.pdf'), 'renamed.pdf');
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.meta.id).toBe(first.meta.id);
    expect(vault.listPapers()).toHaveLength(1);
  });

  it('gives CJK titles a usable id', async () => {
    const { meta } = await vault.importPdf(fixture('cpn-zh.pdf'), 'zh.pdf');
    expect(meta.id).toMatch(/^paper-[0-9a-f]{6}$/);
    expect(vault.getPaper(meta.id).title).toContain('级联');
  });

  it('rejects files that are not PDFs', async () => {
    await expect(vault.importPdf(Buffer.from('hello'), 'x.pdf')).rejects.toThrow('valid PDF');
  });

  it('refuses ids that could escape the vault', () => {
    expect(() => vault.getPaper('../../etc')).toThrow(NotFound);
    expect(() => vault.getBlog('ok', '../secret')).toThrow(NotFound);
    expect(() => vault.audioPath('ok', '..')).toThrow(NotFound);
  });

  it('round-trips a blog, including front matter', async () => {
    const { meta } = await vault.importPdf(fixture('cpn.pdf'), 'a.pdf');
    const id = newOutputId();
    const now = new Date().toISOString();
    vault.saveBlog(meta.id, {
      id, title: 'T: "quoted"', style: 'explainer', language: 'zh', agent: 'claude', createdAt: now, updatedAt: now, chars: 0,
      markdown: '# T\n\n---\n\nBody with a rule',
    });
    const blog = vault.getBlog(meta.id, id);
    expect(blog.title).toBe('T: "quoted"');
    expect(blog.markdown.trim()).toBe('# T\n\n---\n\nBody with a rule');
    expect(blog.mode).toBeUndefined();
    expect(blog.sources).toBeUndefined();
    expect(vault.getPaper(meta.id).blogCount).toBe(1);
  });

  it('finds an arXiv paper with or without a version', async () => {
    const { meta } = await vault.importPdf(fixture('cpn.pdf'), 'a.pdf', { arxivId: '1706.03762v7', title: 'Known title' });
    expect(meta.title).toBe('Known title');
    expect(vault.findArxiv('1706.03762')?.id).toBe(meta.id);
    expect(vault.findArxiv('1706.03762v7')?.id).toBe(meta.id);
    expect(vault.findArxiv('1706.03762v2')).toBeUndefined();
  });

  it('keeps a collection\'s outputs separate and survives a deleted paper', async () => {
    const a = (await vault.importPdf(fixture('cpn.pdf'), 'a.pdf')).meta;
    const b = (await vault.importPdf(fixture('cpn-zh.pdf'), 'b.pdf')).meta;
    const collection = vault.createCollection('本周论文', [a.id, b.id, a.id]);
    expect(collection.paperIds).toEqual([a.id, b.id]);

    const now = new Date().toISOString();
    vault.saveBlog(collection.id, {
      id: newOutputId(), title: 'T', style: 's', language: 'zh', agent: 'x', createdAt: now, updatedAt: now, chars: 0,
      markdown: '# T', sources: [a.id, b.id], mode: 'review',
    });
    const [blog] = vault.listBlogs(collection.id);
    expect(blog.sources).toEqual([a.id, b.id]);
    expect(blog.mode).toBe('review');
    expect(vault.getPaper(a.id).blogCount).toBe(0);
    expect(vault.getCollection(collection.id).blogCount).toBe(1);
    expect(vault.listOutputs()[0].paperId).toBe(collection.id);

    vault.trashPaper(b.id);
    expect(vault.getCollection(collection.id).papers.map((p) => p.id)).toEqual([a.id]);

    vault.trashCollection(collection.id);
    expect(vault.listCollections()).toEqual([]);
    expect(vault.getPaper(a.id).id).toBe(a.id);
  });

  it('never lets a paper id look like a collection id', async () => {
    const { meta } = await vault.importPdf(fixture('cpn.pdf'), 'collection--x.pdf', { title: 'Collection -- x' });
    expect(meta.id.startsWith('collection--')).toBe(false);
  });

  describe('reader chats from before they could act', () => {
    const question = (content: string) => ({ role: 'user' as const, content, at: new Date().toISOString() });

    it('moves each session over as a chat beside its paper, once', async () => {
      const a = (await vault.importPdf(fixture('cpn.pdf'), 'a.pdf')).meta.id;
      const dir = join(vault.paperDir(a), 'chats');
      mkdirSync(dir, { recursive: true });
      const old = {
        id: 'old-chat',
        title: 'First question',
        harness: 'pi',
        model: 'm',
        thinking: '',
        messageCount: 2,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
        messages: [
          { ...question('First question'), selection: 'quoted', page: 2 },
          { role: 'assistant', content: 'Answer', repo: { owner: 'o', name: 'n', sha: 'a'.repeat(40) }, filesRead: ['x.py'], at: '2020-01-02T00:00:00.000Z' },
        ],
      };
      writeFileSync(join(dir, 'old-chat.json'), JSON.stringify(old));

      vault.migrateChats(a, 'claude');
      const moved = vault.getAssistantSession('old-chat');
      expect(moved).toMatchObject({ title: 'First question', harness: 'pi', model: 'm', paperId: a, allowReads: false, messageCount: 2 });
      expect(moved.messages).toEqual(old.messages);
      expect(existsSync(dir)).toBe(false);
      vault.migrateChats(a, 'claude');
      expect(vault.listAssistantSessions().filter((s) => s.paperId === a)).toHaveLength(1);
    });

    it('turns the old single conversation into a session too', async () => {
      const a = (await vault.importPdf(fixture('cpn.pdf'), 'a.pdf')).meta.id;
      const legacy = [question('  Old\n question '), { role: 'assistant' as const, content: 'Old answer', agent: 'pi · some/model', at: '2020-01-01T00:00:00.000Z' }];
      writeFileSync(join(vault.paperDir(a), 'chat.json'), JSON.stringify(legacy));

      vault.migrateChats(a, 'claude');
      const [session] = vault.listAssistantSessions().filter((s) => s.paperId === a);
      expect(session).toMatchObject({ title: 'Old question', harness: 'pi', messageCount: 2, updatedAt: '2020-01-01T00:00:00.000Z' });
      expect(session.messages[1].content).toBe('Old answer');
      expect(existsSync(join(vault.paperDir(a), 'chat.json'))).toBe(false);
    });

    it('never overwrites a chat that already has the id', async () => {
      const a = (await vault.importPdf(fixture('cpn.pdf'), 'a.pdf')).meta.id;
      vault.saveAssistantSession({ id: 'taken', title: 'Mine', harness: 'claude', model: '', thinking: '', allowReads: false, messageCount: 0, createdAt: '', updatedAt: '', messages: [] });
      mkdirSync(join(vault.paperDir(a), 'chats'), { recursive: true });
      writeFileSync(join(vault.paperDir(a), 'chats', 'taken.json'), JSON.stringify({ id: 'taken', title: 'Old', harness: 'pi', model: '', thinking: '', messageCount: 0, createdAt: '', updatedAt: '', messages: [] }));
      vault.migrateChats(a, 'claude');
      expect(vault.getAssistantSession('taken').title).toBe('Mine');
      expect(vault.listAssistantSessions().find((s) => s.paperId === a)?.title).toBe('Old');
    });
  });

  it('moves deleted content to the trash instead of removing it', async () => {
    const { meta } = await vault.importPdf(fixture('cpn.pdf'), 'a.pdf');
    vault.trashPaper(meta.id);
    expect(vault.listPapers()).toEqual([]);
    expect(() => vault.getPaper(meta.id)).toThrow(NotFound);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(root, '.trash'))[0]).toContain(meta.id);
  });
});
