import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperFigure } from '../shared/types.js';
import { openPdf } from './pdf.js';

/** Bump when detection changes, so cached results get recomputed. */
export const FIGURES_VERSION = 2;

const RENDER_SCALE = 2.2;
const MAX_WIDTH = 1800;

interface Box {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  height: number;
}

/** Matches a line that starts a caption, but not prose such as "Figure 2 shows". */
export const CAPTION = /^(?:Figure|FIGURE|Fig\.?|FIG\.?|图)\s*(\d{1,3}(?:\.\d{1,3})?)(?:\s*[:：.．|]\s*|\s+(?=[A-Z㐀-鿿]))(.*)$/;

/** Groups upright text into lines with page coordinates measured from the top. */
export function layoutLines(items: any[], pageHeight: number): Box[] {
  const lines: Box[] = [];
  let current: Box | null = null;
  let baseline = 0;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const [a, b, , d, x, y] = item.transform;
    // Rotated labels belong to figures, and are never body text.
    if (Math.abs(b) > 0.01 || a <= 0) continue;
    const height = item.height || Math.abs(d);
    // `y` is the baseline, so the box is widened to cover ascenders and descenders.
    const box = { x0: x, x1: x + item.width, top: pageHeight - y - height, bottom: pageHeight - y + height * 0.3 };
    const gap = current ? x - current.x1 : 0;
    if (!current || Math.abs(baseline - y) > Math.max(1.5, height * 0.4) || gap > height * 4 || gap < -height) {
      current = { text: item.str, height, ...box };
      baseline = y;
      lines.push(current);
    } else {
      // Whitespace-only items were skipped above, so word gaps have to be restored from geometry.
      current.text += gap > height * 0.15 && !current.text.endsWith(' ') ? ` ${item.str}` : item.str;
      current.x1 = Math.max(current.x1, box.x1);
      current.top = Math.min(current.top, box.top);
      current.bottom = Math.max(current.bottom, box.bottom);
      current.height = Math.max(current.height, height);
    }
  }
  return lines;
}

/** Fewer than this in a column could be a chart's axis. */
const MIN_MARGIN_NUMBERS = 8;

/** Drops the line numbers in a review copy's margin, which would otherwise count as the edge of the text. */
export function withoutMarginNumbers(lines: Box[]): Box[] {
  const columns = new Map<number, Box[]>();
  for (const line of lines) {
    if (!/^\d{1,4}$/.test(line.text.trim())) continue;
    const column = Math.round(line.x1 / 2);
    columns.set(column, [...(columns.get(column) ?? []), line]);
  }
  const dropped = new Set<Box>();
  for (const column of columns.values()) {
    const numbers = [...column].sort((a, b) => a.top - b.top).map((l) => Number(l.text));
    const counting = numbers.filter((n, i) => i > 0 && n === numbers[i - 1] + 1).length;
    if (column.length >= MIN_MARGIN_NUMBERS && counting >= (column.length - 1) * 0.8) column.forEach((l) => dropped.add(l));
  }
  return lines.filter((l) => !dropped.has(l));
}

/** Shorter than this is more likely a label in a figure at the top of a page than a running head. */
const MIN_HEAD_LENGTH = 8;

/** The topmost lines of a page, if they sit in the top margin area. */
function topLines(lines: Box[], height: number): Box[] {
  const top = Math.min(...lines.map((l) => l.top));
  return top < height * 0.1 ? lines.filter((l) => l.top < top + 2) : [];
}

const headKey = (text: string) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/** Text that heads more than one page, with page numbers ignored. Odd and even pages may each have their own. */
export function findRunningHeads(pages: { lines: Box[]; height: number }[]): Set<string> {
  const seen = new Map<string, number>();
  for (const { lines, height } of pages) {
    for (const key of new Set(topLines(lines, height).map((l) => headKey(l.text)))) {
      if (key.length >= MIN_HEAD_LENGTH) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key));
}

/** Takes off a page's running head, and returns where the page's content can start. */
function withoutRunningHead(lines: Box[], height: number, heads: Set<string>): { lines: Box[]; contentTop: number } {
  const row = topLines(lines, height);
  if (!row.some((l) => heads.has(headKey(l.text)))) return { lines, contentTop: height * 0.05 };
  // A page number next to the head is part of the same row.
  return { lines: lines.filter((l) => !row.includes(l)), contentTop: Math.max(...row.map((l) => l.bottom)) };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

interface PageLayout {
  lines: Box[];
  width: number;
  height: number;
  left: number;
  right: number;
  bodyHeight: number;
  twoColumn: boolean;
  /** Where a figure with nothing above it can start. */
  contentTop: number;
}

export function analysePage(lines: Box[], width: number, height: number, contentTop = height * 0.05): PageLayout {
  const left = Math.min(width * 0.12, ...lines.map((l) => l.x0));
  const right = Math.max(width * 0.88, ...lines.map((l) => l.x1));
  const textWidth = right - left;
  // Weighted by length, so that labels inside figures don't set the body size.
  const bodyHeight = median(lines.filter((l) => l.text.length > 30).map((l) => l.height)) || median(lines.map((l) => l.height));
  const wide = lines.filter((l) => l.x1 - l.x0 > textWidth * 0.62).length;
  const columnar = lines.filter((l) => l.x1 - l.x0 > textWidth * 0.3 && l.x1 - l.x0 < textWidth * 0.55 && l.text.length > 25);
  const inLeft = columnar.filter((l) => l.x1 < width / 2 + 4).length;
  const inRight = columnar.filter((l) => l.x0 > width / 2 - 4).length;
  return { lines, width, height, left, right, bodyHeight, twoColumn: wide < 6 && inLeft >= 4 && inRight >= 4, contentTop };
}

interface Region {
  n: string;
  caption: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/** A band above a caption shorter than this can't hold a figure, so the figure must be below. */
const CAPTION_ABOVE_BAND = 36;

/** Finds caption lines, then the blank-of-prose band next to each one. */
export function findRegions(layout: PageLayout): Region[] {
  const { lines, width, height, left, right, bodyHeight, twoColumn, contentTop } = layout;
  const regions: Region[] = [];

  for (const line of lines) {
    const match = line.text.trim().match(CAPTION);
    if (!match) continue;

    let x0 = left;
    let x1 = right;
    if (twoColumn && (line.x1 < width / 2 + 6 || line.x0 > width / 2 - 6)) {
      if (line.x1 < width / 2 + 6) x1 = width / 2;
      else x0 = width / 2;
    }
    const columnWidth = x1 - x0;
    const sameColumn = (l: Box) => l.x1 > x0 + 2 && l.x0 < x1 - 2;
    const isProse = (l: Box) =>
      l.x1 - l.x0 > columnWidth * 0.6 && Math.abs(l.height - bodyHeight) < bodyHeight * 0.3 && l.text.length > 30;

    // The caption may wrap, and it ends at the first line that breaks the rhythm.
    const below = lines.filter((l) => sameColumn(l) && l.top >= line.top + 1).sort((a, b) => a.top - b.top);
    let captionBottom = line.bottom;
    let caption = match[2].trim();
    for (const next of below) {
      if (next.top - captionBottom > line.height * 0.9 || CAPTION.test(next.text.trim()) || caption.length > 600) break;
      caption += ` ${next.text.trim()}`;
      captionBottom = next.bottom;
    }

    const above = lines
      .filter((l) => sameColumn(l) && l.bottom <= line.top + 1)
      .sort((a, b) => b.bottom - a.bottom);
    // Walk upward to the nearest prose, then back down over any short paragraph tail.
    const isNumberedHeading = (l: Box) => l.height >= bodyHeight * 0.98 && /^\d+(\.\d+)*\.?\s+[A-Z\u3400-\u9fff]/.test(l.text.trim());
    const topOfBand = (stopsAt: (l: Box) => boolean) => {
      const proseIndex = above.findIndex((l) => stopsAt(l) || isNumberedHeading(l) || CAPTION.test(l.text.trim()));
      let top = contentTop;
      if (proseIndex >= 0) {
        top = above[proseIndex].bottom;
        for (let i = proseIndex - 1; i >= 0; i--) {
          const l = above[i];
          if (l.top - top > l.height * 0.9 || Math.abs(l.height - bodyHeight) > bodyHeight * 0.3) break;
          top = l.bottom;
        }
      }
      // An unnumbered section heading can sit right above a figure. Larger text further
      // down is left alone, since it is more likely to be a label inside the figure.
      const first = above.filter((l) => l.top >= top - 1).pop();
      if (first && first.height > bodyHeight * 1.12 && first.x0 - x0 < 40 && first.x1 - first.x0 < columnWidth * 0.8) {
        top = first.bottom;
      }
      return top;
    };
    let top = topOfBand(isProse);
    // A long line inside a figure can pass as prose and leave no room for the figure. It stands
    // alone, while the lines of a paragraph share a left edge.
    if (line.top - top < CAPTION_ABOVE_BAND) {
      const proseLines = lines.filter((l) => sameColumn(l) && isProse(l));
      top = topOfBand((l) => isProse(l) && proseLines.some((other) => other !== l && Math.abs(other.x0 - l.x0) < 3));
    }
    regions.push({ n: match[1], caption: caption.replace(/\s+/g, ' '), x0, x1, top: top + 1, bottom: line.top - 1 });

    // Some styles put the caption above the figure.
    if (line.top - top < CAPTION_ABOVE_BAND) {
      const after = below.filter((l) => l.top >= captionBottom - 1);
      const end = after.find((l) => isProse(l) || CAPTION.test(l.text.trim()));
      regions[regions.length - 1] = {
        ...regions[regions.length - 1],
        top: captionBottom + 1,
        bottom: end ? end.top - 1 : height * 0.95,
      };
    }
  }
  return regions;
}

/** In rendered pixels, about five lines of body text. */
const MIN_STRIP_HEIGHT = 150;

const isInk = (data: Uint8ClampedArray, offset: number) =>
  data[offset + 3] > 16 && (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235);

/** Where a blog post stored in the vault can find a figure, relative to itself. */
export function figurePath(ownerIsCollection: boolean, paperId: string, file: string): string {
  return ownerIsCollection ? `../../../papers/${paperId}/figures/${file}` : `../figures/${file}`;
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const FIGURE_PATH = /^(?:\.\.\/)+(?:papers\/[a-z0-9-]+\/)?figures\/[\w-]+\.png$/;

/** Removes images the agent made up, so that a post never shows a broken picture. */
export function keepKnownFigures(markdown: string, allowed: Set<string>): string {
  return markdown.replace(IMAGE, (image, _alt, src: string) => (FIGURE_PATH.test(src) && !allowed.has(src) ? '' : image));
}

/** Embeds figures as data URIs, so that an exported post is one self-contained file. */
export function inlineFigures(markdown: string, resolveFile: (relative: string) => Buffer | null): string {
  return markdown.replace(IMAGE, (image, alt: string, src: string) => {
    if (!FIGURE_PATH.test(src)) return image;
    const data = resolveFile(src);
    return data ? `![${alt}](data:image/png;base64,${data.toString('base64')})` : image;
  });
}

/** Trims blank margins. Returns null unless the band holds graphics, not just more text. */
function trimRegion(
  image: { data: Uint8ClampedArray; width: number; height: number },
  region: Region,
  textBoxes: Box[],
): { x: number; y: number; width: number; height: number } | null {
  const px = (v: number) => Math.round(v * RENDER_SCALE);
  const x0 = Math.max(0, px(region.x0));
  const x1 = Math.min(image.width, px(region.x1));
  const y0 = Math.max(0, px(region.top));
  const y1 = Math.min(image.height, px(region.bottom));
  if (x1 - x0 < 40 || y1 - y0 < 40) return null;

  let minX = x1;
  let maxX = x0;
  let minY = y1;
  let maxY = y0;
  let graphics = 0;
  const boxes = textBoxes
    .filter((b) => b.bottom > region.top && b.top < region.bottom)
    .map((b) => ({ x0: px(b.x0) - 2, x1: px(b.x1) + 2, y0: px(b.top) - 2, y1: px(b.bottom) + 2 }));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!isInk(image.data, (y * image.width + x) * 4)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (!boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)) graphics++;
    }
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 80 || height < 50) return null;
  // A long thin strip is a rule or a stray line of text, not a figure. Some charts are this
  // shape too, but they're taller than a line or two of text.
  if (width / height > 6 && height < MIN_STRIP_HEIGHT) return null;
  if (graphics < width * height * 0.002) return null;
  // The margin stays inside the band, or it would pull in the edge of the caption.
  const pad = 10;
  const x = Math.max(x0, minX - pad);
  const y = Math.max(y0, minY - pad);
  return { x, y, width: Math.min(x1, maxX + pad) - x, height: Math.min(y1, maxY + pad) - y };
}

/** Lowest page first, then lowest figure number, so "2" comes before "10". */
export const byPosition = (a: PaperFigure, b: PaperFigure) => a.page - b.page || a.n.localeCompare(b.n, undefined, { numeric: true });

/** pdf.js can run through a page without returning to the event loop, so requests get a turn here. */
export const letOthersRun = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function figuresSupported(): Promise<boolean> {
  try {
    await import('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
}

/** Crops each captioned figure out of the rendered page, writing `fig-<n>.png` to `outDir`. */
export async function extractFigures(data: Uint8Array, outDir: string): Promise<PaperFigure[]> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { task, doc } = await openPdf(data);
  const figures = new Map<string, PaperFigure>();
  try {
    mkdirSync(outDir, { recursive: true });
    // A running head is only recognisable from the other pages, so all the text is read first.
    const pages: { lines: Box[]; width: number; height: number }[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({ lines: withoutMarginNumbers(layoutLines(content.items as any[], height)), width, height });
      page.cleanup();
      await letOthersRun();
    }
    const heads = findRunningHeads(pages);
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const { width, height, ...read } = pages[pageNumber - 1];
      const { lines, contentTop } = withoutRunningHead(read.lines, height, heads);
      const regions = findRegions(analysePage(lines, width, height, contentTop)).filter((r) => !figures.has(r.n));
      if (regions.length) {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: canvas as any, canvasContext: context as any, viewport } as any).promise;
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        for (const region of regions) {
          const crop = trimRegion(image as any, region, lines);
          if (!crop) continue;
          const scale = Math.min(1, MAX_WIDTH / crop.width);
          const out = createCanvas(Math.round(crop.width * scale), Math.round(crop.height * scale));
          out.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
          const file = `fig-${region.n.replace('.', '-')}.png`;
          writeFileSync(join(outDir, file), await out.encode('png'));
          figures.set(region.n, {
            n: region.n,
            label: `Figure ${region.n}`,
            caption: region.caption,
            page: pageNumber,
            file,
            width: out.width,
            height: out.height,
          });
        }
        page.cleanup();
      }
      await letOthersRun();
    }
  } finally {
    await task.destroy();
  }
  return [...figures.values()].sort(byPosition);
}
