import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractFigures, figurePath, inlineFigures, keepKnownFigures } from '../src/server/figures';

const dir = mkdtempSync(join(tmpdir(), 'p2p-figures-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('extractFigures', () => {
  it('crops captioned graphics and ignores captions and prose without any', async () => {
    const figures = await extractFigures(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'figures.pdf'))), dir);
    expect(figures.map((f) => f.n)).toEqual(['1', '3.1']);
    expect(figures[0]).toMatchObject({ page: 1, file: 'fig-1.png' });
    expect(figures[0].caption).toContain('A blue box');
    expect(figures[1]).toMatchObject({ page: 2, file: 'fig-3-1.png' });
    expect(figures[1].caption).toContain('wraps onto a second line');
    // A PNG was written, sized to the graphic and not to the whole page.
    expect(readFileSync(join(dir, 'fig-1.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(figures[0].height).toBeLessThan(600);
  });
});

describe('figure references', () => {
  it('builds paths relative to where a post is stored', () => {
    expect(figurePath(false, 'p', 'fig-1.png')).toBe('../figures/fig-1.png');
    expect(figurePath(true, 'p', 'fig-1.png')).toBe('../../../papers/p/figures/fig-1.png');
  });

  it('removes figures the agent made up, and keeps real ones', () => {
    const allowed = new Set(['../figures/fig-1.png']);
    const out = keepKnownFigures('A\n\n![real](../figures/fig-1.png)\n\n![fake](../figures/fig-9.png)\n\nB', allowed);
    expect(out).toContain('![real]');
    expect(out).not.toContain('fake');
  });

  it('inlines known files and leaves other images alone', () => {
    const markdown = '![a](../figures/fig-1.png) ![b](https://x.example/y.png) ![c](../figures/fig-2.png)';
    const out = inlineFigures(markdown, (path) => (path.endsWith('fig-1.png') ? Buffer.from('png') : null));
    expect(out).toContain(`![a](data:image/png;base64,${Buffer.from('png').toString('base64')})`);
    expect(out).toContain('https://x.example/y.png');
    expect(out).toContain('![c](../figures/fig-2.png)');
  });
});
