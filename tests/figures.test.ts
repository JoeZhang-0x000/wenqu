import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analysePage,
  extractFigures,
  figurePath,
  findRegions,
  findRunningHeads,
  inlineFigures,
  keepKnownFigures,
  withoutMarginNumbers,
} from '../src/server/figures';

const dir = mkdtempSync(join(tmpdir(), 'wenqu-figures-'));
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

const line = (text: string, top: number, x0: number, x1: number, height = 10) => ({ text, top, bottom: top + height * 1.3, x0, x1, height });
const paragraph = (top: number, count: number, x0 = 52, x1 = 560) =>
  Array.from({ length: count }, (_, i) => line(`Plain prose that runs the whole width of the text, line ${i}.`, top + i * 12, x0, x1));
const regions = (lines: ReturnType<typeof line>[]) => findRegions(analysePage(lines, 612, 792));

describe('findRegions', () => {
  it('keeps a long centred line inside a figure from passing as prose', () => {
    const [region] = regions([
      line('Boxes and arrows', 80, 200, 300),
      line('0 target-prefix tokens and a real bridge token, then continuation', 170, 133, 479),
      line('Figure 1: What crosses the boundary, which takes more than one line to say.', 200, 52, 560),
      ...paragraph(212, 3),
      ...paragraph(300, 8),
    ]);
    expect(region.n).toBe('1');
    expect(region.bottom).toBeLessThan(200);
    expect(region.top).toBeLessThan(80);
  });

  it('still finds prose on a page with wide margins', () => {
    const [region] = regions([
      ...paragraph(100, 6, 133, 479),
      line('Labels', 220, 250, 300),
      line('Figure 1: Boxes and arrows.', 300, 133, 300),
    ]);
    expect(region.top).toBeGreaterThan(160);
    expect(region.top).toBeLessThan(220);
  });

  it('still handles a caption above its figure', () => {
    const [region] = regions([
      ...paragraph(100, 6),
      line('Figure 1: A caption above, in a line that runs across the width of the page.', 176, 52, 560),
      line('Labels', 260, 200, 300),
      ...paragraph(400, 3),
    ]);
    expect(region.top).toBeGreaterThan(176);
    expect(region.bottom).toBeLessThan(400);
  });
});

describe('page furniture', () => {
  it('finds text heading several pages, whatever the page number', () => {
    const page = (text: string) => ({ height: 792, lines: [line(text, 45, 170, 430), line('Body', 200, 52, 560)] });
    const heads = findRunningHeads([page('Title page text'), page('Marconi: Prefix Caching 2'), page('Marconi: Prefix Caching 3'), page('Another odd line')]);
    expect([...heads]).toEqual(['marconi: prefix caching #']);
  });

  it('ignores repeats that are too short or lower down the page', () => {
    const page = (text: string, top: number) => ({ height: 792, lines: [line(text, top, 170, 430)] });
    expect(findRunningHeads([page('SSM', 45), page('SSM', 45)]).size).toBe(0);
    expect(findRunningHeads([page('A long repeated label', 200), page('A long repeated label', 200)]).size).toBe(0);
  });

  it('drops margin line numbers, and leaves the ticks of a chart', () => {
    const numbers = Array.from({ length: 10 }, (_, i) => line(String(55 + i), 67 + i * 12, 27, 42));
    const ticks = Array.from({ length: 10 }, (_, i) => line(String(i * 20), 100 + i * 12, 200, 215));
    const body = paragraph(100, 2);
    expect(withoutMarginNumbers([...numbers, ...ticks, ...body])).toEqual([...ticks, ...body]);
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
