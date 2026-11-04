import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperFigure } from '../shared/types.js';
import { openPdf } from './pdf.js';

/** Bump when detection changes, so cached results get recomputed. */
export const FIGURES_VERSION = 1;

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
const CAPTION = /^(?:Figure|FIGURE|Fig\.?|FIG\.?|图)\s*(\d{1,3}(?:\.\d{1,3})?)(?:\s*[:：.．|]\s*|\s+(?=[A-Z㐀-鿿]))(.*)$/;

/** Groups upright text into lines with page coordinates measured from the top. */
function layoutLines(items: any[], pageHeight: number): Box[] {
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
}

function analysePage(lines: Box[], width: number, height: number): PageLayout {
  const left = Math.min(width * 0.12, ...lines.map((l) => l.x0));
  const right = Math.max(width * 0.88, ...lines.map((l) => l.x1));
  const textWidth = right - left;
  // Weighted by length, so that labels inside figures don't set the body size.
  const bodyHeight = median(lines.filter((l) => l.text.length > 30).map((l) => l.height)) || median(lines.map((l) => l.height));
  const wide = lines.filter((l) => l.x1 - l.x0 > textWidth * 0.62).length;
  const columnar = lines.filter((l) => l.x1 - l.x0 > textWidth * 0.3 && l.x1 - l.x0 < textWidth * 0.55 && l.text.length > 25);
  const inLeft = columnar.filter((l) => l.x1 < width / 2 + 4).length;
  const inRight = columnar.filter((l) => l.x0 > width / 2 - 4).length;
  return { lines, width, height, left, right, bodyHeight, twoColumn: wide < 6 && inLeft >= 4 && inRight >= 4 };
}

interface Region {
  n: string;
  caption: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/** Finds caption lines, then the blank-of-prose band next to each one. */
function findRegions(layout: PageLayout): Region[] {
  const { lines, width, height, left, right, bodyHeight, twoColumn } = layout;
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
    const proseIndex = above.findIndex((l) => isProse(l) || isNumberedHeading(l) || CAPTION.test(l.text.trim()));
    let top = height * 0.05;
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
    regions.push({ n: match[1], caption: caption.replace(/\s+/g, ' '), x0, x1, top: top + 1, bottom: line.top - 1 });

    // Some styles put the caption above the figure.
    if (line.top - top < 36) {
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
  // A long thin strip is a rule or a stray line of text, not a figure.
  if (width / height > 6) return null;
  if (graphics < width * height * 0.002) return null;
  // The margin stays inside the band, or it would pull in the edge of the caption.
  const pad = 10;
  const x = Math.max(x0, minX - pad);
  const y = Math.max(y0, minY - pad);
  return { x, y, width: Math.min(x1, maxX + pad) - x, height: Math.min(y1, maxY + pad) - y };
}

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
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = layoutLines(content.items as any[], height);
      const regions = findRegions(analysePage(lines, width, height)).filter((r) => !figures.has(r.n));
      if (regions.length) {
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
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return [...figures.values()].sort((a, b) => a.page - b.page || a.n.localeCompare(b.n, undefined, { numeric: true }));
}
