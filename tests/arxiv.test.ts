import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupArxiv, parseArxivEntries, parseArxivFeed, parseArxivInput, resetApiPacing } from '../src/server/arxiv';
import { Vault } from '../src/server/vault';

describe('parseArxivInput', () => {
  it.each([
    ['1706.03762', '1706.03762'],
    ['1706.03762v7', '1706.03762v7'],
    ['arXiv:2401.12345', '2401.12345'],
    ['https://arxiv.org/abs/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v5.pdf', '1706.03762v5'],
    ['http://www.arxiv.org/abs/1706.03762/', '1706.03762'],
    ['arxiv.org/abs/2005.14165', '2005.14165'],
    ['https://www.alphaxiv.org/abs/2005.14165', '2005.14165'],
    ['https://arxiv.org/abs/hep-th/9901001v2', 'hep-th/9901001v2'],
    ['math.GT/0309136', 'math.GT/0309136'],
  ])('accepts %s', (input, id) => {
    expect(parseArxivInput(input)).toBe(id);
  });

  it.each(['', 'hello', 'paper.pdf', 'https://evil.example/abs/1706.03762', 'https://arxiv.org/list/cs.AI/recent', '1706.0'])('rejects %s', (input) => {
    expect(parseArxivInput(input)).toBeNull();
  });
});

describe('parseArxivFeed', () => {
  const feed = `<feed><title>arXiv Query</title><entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is
      All You &amp; Need</title>
    <summary> The dominant
      models. </summary>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name><arxiv:affiliation>Google</arxiv:affiliation></author>
  </entry></feed>`;

  it('reads the entry, not the feed header', () => {
    expect(parseArxivFeed(feed)).toEqual({
      arxivId: '1706.03762v7',
      title: 'Attention Is All You & Need',
      abstract: 'The dominant models.',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
    });
  });

  it('returns null when nothing was found', () => {
    expect(parseArxivFeed('<feed><title>arXiv Query</title></feed>')).toBeNull();
  });
});

describe('parseArxivEntries', () => {
  it('reads every entry and skips the error entry arXiv sends for a bad id', () => {
    const feed = `<feed>
      <entry><id>http://arxiv.org/abs/1706.03762v7</id><title>A</title></entry>
      <entry><id>http://arxiv.org/api/errors#incorrect_id</id><title>Error</title></entry>
      <entry><id>http://arxiv.org/abs/hep-th/9901001v2</id><title>B</title></entry>
    </feed>`;
    expect(parseArxivEntries(feed).map((e) => e.arxivId)).toEqual(['1706.03762v7', 'hep-th/9901001v2']);
  });
});

describe('lookupArxiv', () => {
  const vault = { listPapers: () => [{ id: 'gpt-3', arxivId: '2005.14165v4' }], findArxiv: Vault.prototype.findArxiv } as any;
  const feed = `<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention</title></entry></feed>`;

  beforeEach(() => resetApiPacing());
  afterEach(() => vi.unstubAllGlobals());

  it('matches entries by id whatever the version, and reports what it could not find', async () => {
    const fetchMock = vi.fn(async () => new Response(feed));
    vi.stubGlobal('fetch', fetchMock);
    const results = await lookupArxiv(vault, ['https://arxiv.org/abs/1706.03762', 'nonsense', '2005.14165']);
    expect(results.map((r) => r.status)).toEqual(['found', 'invalid', 'missing']);
    expect(results[0].meta?.title).toBe('Attention');
    expect(results[2].paperId).toBe('gpt-3');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0])).not.toContain('nonsense');
  });

  it('prefers the exact version when two are asked for together', async () => {
    const both = `<feed>
      <entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Latest</title></entry>
      <entry><id>http://arxiv.org/abs/1706.03762v5</id><title>Fifth</title></entry>
    </feed>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(both)));
    const results = await lookupArxiv(vault, ['1706.03762v5', '1706.03762']);
    expect(results.map((r) => r.meta?.title)).toEqual(['Fifth', 'Latest']);
  });

  it('asks arXiv nothing when no input names a paper', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await lookupArxiv(vault, ['nonsense']))[0].status).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns the ids when arXiv cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const [result] = await lookupArxiv(vault, ['1706.03762']);
    expect(result).toMatchObject({ id: '1706.03762', status: 'unknown' });
  });
});
