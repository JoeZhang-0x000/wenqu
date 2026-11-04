import { describe, expect, it } from 'vitest';
import { parseArxivFeed, parseArxivInput } from '../src/server/arxiv';

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
