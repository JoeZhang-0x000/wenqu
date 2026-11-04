import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPdf, pageMarkedText } from '../src/server/pdf';
import { NotFound, Vault, newOutputId } from '../src/server/vault';

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
    root = mkdtempSync(join(tmpdir(), 'p2p-vault-'));
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

  it('moves deleted content to the trash instead of removing it', async () => {
    const { meta } = await vault.importPdf(fixture('cpn.pdf'), 'a.pdf');
    vault.trashPaper(meta.id);
    expect(vault.listPapers()).toEqual([]);
    expect(() => vault.getPaper(meta.id)).toThrow(NotFound);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(root, '.trash'))[0]).toContain(meta.id);
  });
});
