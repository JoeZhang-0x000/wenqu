import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperFigure } from '../src/shared/types';
import { Config } from '../src/server/config';
import { COVER_VERSION, chooseCover, largestRasterShare, locateFirstFigurePage } from '../src/server/cover';
import { extractFigures } from '../src/server/figures';
import { createApp, listen } from '../src/server/server';
import type { Vault } from '../src/server/vault';

const canvas = vi.hoisted(() => ({ supported: true, running: 0, mostRunning: 0, extractions: 0 }));
vi.mock('../src/server/figures', async (original) => {
  const real = await original<typeof import('../src/server/figures')>();
  return {
    ...real,
    figuresSupported: async () => canvas.supported && real.figuresSupported(),
    extractFigures: async (data: Uint8Array, dir: string) => {
      canvas.extractions++;
      canvas.mostRunning = Math.max(canvas.mostRunning, ++canvas.running);
      try {
        return await real.extractFigures(data, dir);
      } finally {
        canvas.running--;
      }
    },
  };
});

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

/** A valid PDF from content streams, whose `/Im0` is a one-pixel image and `/Fm0` a form that draws it at half size. */
function buildPdf(pages: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 1000 1000] /Matrix [0.5 0 0 0.5 0 0] /Resources << /XObject << /Im0 4 0 R >> >> /Length 30 >>\nstream\nq 200 0 0 200 0 0 cm /Im0 Do Q\nendstream',
  ];
  for (const [i, content] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${7 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 4 0 R /Fm0 5 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const text = (line: string) => `BT /F1 10 Tf 72 400 Td (${line}) Tj ET`;
const prose = text('Some plain prose that mentions no pictures at all.');
/** Page area is 480000, so 200 x 200 is about 8% and 50 x 50 about 0.5%. */
const image = (size: number) => `q ${size} 0 0 ${size} 100 100 cm /Im0 Do Q`;

const figure = (n: string, page: number, extra: Partial<PaperFigure> = {}): PaperFigure => ({
  n,
  label: `Figure ${n}`,
  caption: '',
  page,
  file: `fig-${n}.png`,
  width: 100,
  height: 100,
  ...extra,
});

describe('chooseCover', () => {
  const never = async () => {
    throw new Error('should not need to look');
  };

  it('takes the crop on the lowest page, then with the lowest number', async () => {
    const figures = [figure('1', 5), figure('10', 2), figure('2', 2)];
    expect(await chooseCover(figures, () => true, never)).toEqual({ figure: 'fig-2.png', page: 2 });
  });

  it('skips a figure the user removed', async () => {
    const figures = [figure('1', 2, { excluded: true }), figure('2', 4)];
    expect(await chooseCover(figures, () => true, never)).toEqual({ figure: 'fig-2.png', page: 4 });
  });

  it('skips a crop whose file is gone', async () => {
    const figures = [figure('1', 2), figure('2', 4)];
    expect(await chooseCover(figures, (file) => file !== 'fig-1.png', never)).toEqual({ figure: 'fig-2.png', page: 4 });
  });

  it('uses the known page when no crop is usable, without scanning', async () => {
    expect(await chooseCover([figure('1', 3, { excluded: true })], () => true, never)).toEqual({ page: 3 });
    expect(await chooseCover([figure('1', 7)], () => false, never)).toEqual({ page: 7 });
  });

  it('locates the page when nothing was extracted', async () => {
    expect(await chooseCover([], () => true, async () => 6)).toEqual({ page: 6 });
  });

  it('falls back to page 1 when nothing is found, or the search fails', async () => {
    expect(await chooseCover([], () => true, async () => null)).toEqual({ page: 1 });
    expect(await chooseCover([], () => true, never)).toEqual({ page: 1 });
  });
});

describe('largestRasterShare', () => {
  const ops = { save: 1, restore: 2, transform: 3, paintFormXObjectBegin: 4, paintFormXObjectEnd: 5, paintImageXObject: 6, paintInlineImageXObject: 7, paintImageMaskXObject: 8 };
  const view = [0, 0, 100, 100];
  const share = (list: [number, unknown?][], onPage = view) => largestRasterShare(list.map(([fn]) => fn), list.map(([, args]) => args), ops, onPage);

  it('composes transforms, and restores them', () => {
    expect(share([[ops.save], [ops.transform, [50, 0, 0, 50, 0, 0]], [ops.paintImageXObject], [ops.restore], [ops.paintImageXObject]])).toBeCloseTo(0.25);
    expect(share([[ops.transform, [10, 0, 0, 10, 0, 0]], [ops.transform, [2, 0, 0, 2, 0, 0]], [ops.paintInlineImageXObject]])).toBeCloseTo(0.04);
    expect(share([[ops.save], [ops.transform, [90, 0, 0, 90, 0, 0]], [ops.restore], [ops.paintImageXObject]])).toBeCloseTo(0.0001);
  });

  it('applies a form matrix for the length of the form', () => {
    const list: [number, unknown?][] = [
      [ops.transform, [100, 0, 0, 100, 0, 0]],
      [ops.paintFormXObjectBegin, [[0.1, 0, 0, 0.1, 0, 0], [0, 0, 1, 1]]],
      [ops.paintImageXObject],
    ];
    expect(share(list)).toBeCloseTo(0.01);
    expect(share([...list, [ops.paintFormXObjectEnd], [ops.paintImageMaskXObject]])).toBeCloseTo(1);
  });

  it('counts only what is on the page, wherever the page starts', () => {
    expect(share([[ops.transform, [100, 0, 0, 100, 90, 0]], [ops.paintImageXObject]])).toBeCloseTo(0.1);
    expect(share([[ops.transform, [10, 0, 0, 10, 500, 500]], [ops.paintImageXObject]])).toBe(0);
    expect(share([[ops.transform, [100, 0, 0, 100, 50, 50]], [ops.paintImageXObject]], [50, 50, 150, 150])).toBeCloseTo(1);
  });

  it('handles a rotated image', () => {
    expect(share([[ops.transform, [0, 50, -50, 0, 50, 0]], [ops.paintImageXObject]])).toBeCloseTo(0.25);
  });
});

describe('locateFirstFigurePage', () => {
  const locate = (pdf: Buffer) => locateFirstFigurePage(new Uint8Array(pdf));

  it('agrees with extraction on the fixtures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wenqu-cover-'));
    try {
      const figures = await extractFigures(new Uint8Array(fixture('figures.pdf')), dir);
      expect(await locate(fixture('figures.pdf'))).toBe(figures[0].page);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a caption, but not prose that mentions a figure', async () => {
    expect(await locate(buildPdf([prose, text('As Figure 2 shows, this is prose.'), text('Figure 1: The real caption.')]))).toBe(3);
    expect(await locate(buildPdf([prose, prose]))).toBeNull();
  });

  it('prefers a later caption over an earlier image', async () => {
    expect(await locate(buildPdf([image(400), text('Fig. 1. The caption.')]))).toBe(2);
  });

  it('finds an image of a meaningful size when there are no captions', async () => {
    expect(await locate(buildPdf([prose, image(50), image(200)]))).toBe(3);
  });

  it('sees an image drawn through a form, at the scale the form gives it', async () => {
    // 100 x 100 is about 2%, and it would pass if the form's matrix of 0.5 were ignored.
    expect(await locate(buildPdf(['/Fm0 Do']))).toBeNull();
    expect(await locate(buildPdf(['q 2 0 0 2 0 0 cm /Fm0 Do Q']))).toBe(1);
  });
});

describe('cover routes', () => {
  let root: string;
  let server: Server;
  let base: string;
  let vault: Vault;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let next = 0;

  /** Every test gets its own copy, since a paper's id comes from its content. */
  const addPaper = async (pdf: Buffer = fixture('figures.pdf')) => {
    const unique = Buffer.concat([pdf, Buffer.from(`\n% ${next++}\n`)]);
    return (await vault.importPdf(unique, 'paper.pdf')).meta.id;
  };
  const plan = async (id: string) => (await fetch(`${base}/api/papers/${id}/cover`)).json() as Promise<any>;
  const upload = (id: string, query: string, body: Buffer = jpeg) => fetch(`${base}/api/papers/${id}/thumb?${query}`, { method: 'PUT', body });
  const exclude = (id: string, n: string, excluded = true) =>
    fetch(`${base}/api/papers/${id}/figures/${n}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excluded }) });
  const marker = (id: string) => join(vault.paperDir(id), 'cover.json');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wenqu-cover-routes-'));
    process.env.WENQU_CONFIG_DIR = join(root, 'config');
    const created = createApp({ config: new Config(join(root, 'vault')) });
    vault = created.getVault();
    ({ server } = await listen(created.app, 4650));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
    delete process.env.WENQU_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    canvas.supported = true;
    canvas.mostRunning = 0;
    canvas.extractions = 0;
  });

  it('plans a crop of the first figure, and reuses the extraction', async () => {
    const id = await addPaper();
    expect(vault.getPaper(id)).toMatchObject({ hasThumb: false, coverStale: true });
    expect(await plan(id)).toEqual({ settled: false, figure: 'fig-1.png', page: 1 });
    expect(await plan(id)).toEqual({ settled: false, figure: 'fig-1.png', page: 1 });
    expect(canvas.extractions).toBe(1);
    expect(vault.readFigures(id, 1)).not.toBeNull();
  });

  it('settles once a cover is uploaded, without looking at the paper again', async () => {
    const id = await addPaper();
    await plan(id);
    const { thumbStamp } = (await (await upload(id, 'kind=figure&page=1')).json()) as any;
    expect(vault.getPaper(id)).toMatchObject({ hasThumb: true, coverStale: false, thumbStamp });
    expect(JSON.parse(readFileSync(marker(id), 'utf8'))).toEqual({ version: COVER_VERSION, kind: 'figure', page: 1 });

    canvas.extractions = 0;
    rmSync(vault.figuresDir(id), { recursive: true });
    expect(await plan(id)).toEqual({ settled: true, thumbStamp });
    expect(canvas.extractions).toBe(0);
    expect(existsSync(vault.figuresDir(id))).toBe(false);
  });

  it('counts a whole-page fallback to page 1 as settled', async () => {
    const id = await addPaper(buildPdf([prose, prose]));
    expect(await plan(id)).toEqual({ settled: false, page: 1 });
    await upload(id, 'kind=page&page=1');
    expect((await plan(id)).settled).toBe(true);
    expect(vault.getPaper(id).coverStale).toBe(false);
  });

  it('migrates an old thumbnail without touching it until the new one arrives', async () => {
    const id = await addPaper();
    const old = Buffer.from('old cover');
    writeFileSync(vault.thumbPath(id), old);
    expect(vault.getPaper(id)).toMatchObject({ hasThumb: true, coverStale: true });

    expect((await plan(id)).figure).toBe('fig-1.png');
    expect(readFileSync(vault.thumbPath(id))).toEqual(old);
    const shown = await fetch(`${base}/api/papers/${id}/thumb?v=${vault.getPaper(id).thumbStamp}`);
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(old);

    await upload(id, 'kind=figure&page=1');
    expect(readFileSync(vault.thumbPath(id))).toEqual(jpeg);
    expect(vault.getPaper(id).coverStale).toBe(false);
  });

  it('chooses again only when the version moves', async () => {
    const id = await addPaper();
    await upload(id, 'kind=page&page=1');
    writeFileSync(marker(id), JSON.stringify({ version: COVER_VERSION - 1, kind: 'page', page: 1 }));
    expect(vault.getPaper(id).coverStale).toBe(true);
    writeFileSync(marker(id), '{ broken');
    expect(vault.getPaper(id).coverStale).toBe(true);
  });

  it('chooses again if the image was deleted', async () => {
    const id = await addPaper();
    await upload(id, 'kind=page&page=1');
    rmSync(vault.thumbPath(id));
    expect(vault.getPaper(id)).toMatchObject({ hasThumb: false, coverStale: true });
  });

  it('remembers a failure, and keeps what the card had', async () => {
    const id = await addPaper();
    writeFileSync(vault.thumbPath(id), jpeg);
    await fetch(`${base}/api/papers/${id}/cover/failed`, { method: 'POST' });
    expect(vault.getPaper(id)).toMatchObject({ hasThumb: true, coverStale: false });
    expect((await plan(id)).settled).toBe(true);
    expect(readFileSync(vault.thumbPath(id))).toEqual(jpeg);

    const blank = await addPaper();
    await fetch(`${base}/api/papers/${blank}/cover/failed`, { method: 'POST' });
    expect(vault.getPaper(blank)).toMatchObject({ hasThumb: false, coverStale: false });
    expect(await plan(blank)).toEqual({ settled: true, thumbStamp: 0 });
  });

  it('still answers for a PDF that cannot be parsed', async () => {
    const id = await addPaper();
    writeFileSync(vault.pdfPath(id), 'not a pdf');
    expect(await plan(id)).toEqual({ settled: false, page: 1 });
  });

  it('refuses an upload that says nothing about the cover, or has no image', async () => {
    const id = await addPaper();
    expect((await upload(id, '')).status).toBe(400);
    expect((await upload(id, 'kind=other&page=1')).status).toBe(400);
    expect((await upload(id, 'kind=page&page=0')).status).toBe(400);
    expect(existsSync(vault.thumbPath(id))).toBe(false);
  });

  it('chooses again when the figure on the cover is removed, keeping the image until then', async () => {
    const id = await addPaper();
    await plan(id);
    await upload(id, 'kind=figure&page=1');

    await exclude(id, '3.1');
    await exclude(id, '3.1', false);
    expect(vault.getPaper(id).coverStale).toBe(false);

    await exclude(id, '1');
    expect(vault.getPaper(id).coverStale).toBe(true);
    expect(readFileSync(vault.thumbPath(id))).toEqual(jpeg);
    expect(await plan(id)).toEqual({ settled: false, figure: 'fig-3-1.png', page: 2 });
  });

  it('uses the page of the first figure when every crop was removed', async () => {
    const id = await addPaper();
    await plan(id);
    await exclude(id, '1');
    await exclude(id, '3.1');
    expect(await plan(id)).toEqual({ settled: false, page: 1 });
  });

  it('finds the whole page without canvas', async () => {
    canvas.supported = false;
    const caption = await addPaper(buildPdf([prose, prose, text('Figure 1: A caption.')]));
    expect(await plan(caption)).toEqual({ settled: false, page: 3 });
    const raster = await addPaper(buildPdf([prose, image(200)]));
    expect(await plan(raster)).toEqual({ settled: false, page: 2 });
    expect(canvas.extractions).toBe(0);
  });

  it('extracts one paper at a time, however many are asked for', async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => addPaper()));
    await Promise.all(ids.map(plan));
    expect(canvas.extractions).toBe(4);
    expect(canvas.mostRunning).toBe(1);
  });

  it('keeps cover state out of meta.json', async () => {
    const id = await addPaper();
    vault.updatePaper(id, { title: 'Edited' });
    const meta = JSON.parse(readFileSync(join(vault.paperDir(id), 'meta.json'), 'utf8'));
    expect(meta).not.toHaveProperty('coverStale');
    expect(meta).not.toHaveProperty('thumbStamp');
  });
});
