import type { PaperFigure } from '../shared/types.js';
import { CAPTION, byPosition, layoutLines, letOthersRun } from './figures.js';
import { loadPdfjs, openPdf } from './pdf.js';

/**
 * Bump only when the choice below changes, so that every existing cover gets chosen again.
 * A cover from before this marker existed counts as older than any version.
 */
export const COVER_VERSION = 3;

/** `cover.json`, next to `thumb.jpg`. */
export type CoverMarker = { version: number } & ({ kind: 'figure' | 'page'; page: number } | { kind: 'failed' });

/** What a caption's opening says about a figure. A cover should show the method, and most papers open with a result. */
const STRONG = /\b(?:overview|architecture|pipeline|framework|workflow|schematic)\b|概览|总览|架构|框架|流程/i;
const WEAK = /\b(?:illustrat\w*|diagrams?|design|structure|mechanism)\b|示意|结构|设计|原理/i;
const RESULT =
  /\b(?:speedups?|throughput|latency|accuracy|loss|ttft|percentiles?|benchmarks?|versus|vs|comparisons?|compared|results?|evaluations?|distributions?|ratios?|rates?|reductions?|usage|curves?|performance|impact|effects?|sensitivity)\b|性能|影响|对比|比较|准确率|吞吐|延迟|结果|曲线|分布/i;

/** Past this a figure on a card is a strip too thin to make out. */
const THIN_FIGURE = 3.2;

/** Anything smaller is more likely a logo or an icon than a figure. */
const MIN_RASTER_SHARE = 0.04;

type Matrix = number[];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The largest share of the page that a single raster image covers, from a pdf.js operator list. */
export function largestRasterShare(fnArray: number[], argsArray: any[], ops: Record<string, number>, view: number[]): number {
  const [left, bottom, right, top] = view;
  const pageArea = (right - left) * (top - bottom);
  if (pageArea <= 0) return 0;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let largest = 0;
  fnArray.forEach((fn, i) => {
    const args = argsArray[i];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, args);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = multiply(ctm, Array.from(args[0]));
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      // An image fills the unit square, and only the part on the page counts.
      const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
      const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
      const width = Math.min(right, Math.max(...xs)) - Math.max(left, Math.min(...xs));
      const height = Math.min(top, Math.max(...ys)) - Math.max(bottom, Math.min(...ys));
      if (width > 0 && height > 0) largest = Math.max(largest, (width * height) / pageArea);
    }
  });
  return largest;
}

/**
 * Finds the page of the first figure without rendering, for when no crop is available.
 * Most figures are vector graphics, so captions go first: images alone would miss them.
 */
export async function locateFirstFigurePage(data: Uint8Array): Promise<number | null> {
  const { task, doc } = await openPdf(data);
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const found = layoutLines(content.items as any[], height).some((line) => CAPTION.test(line.text.trim()));
      page.cleanup();
      if (found) return n;
      await letOthersRun();
    }
    const { OPS, AnnotationMode } = await loadPdfjs();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
      const share = largestRasterShare(fnArray, argsArray, OPS as any, page.view);
      page.cleanup();
      if (share >= MIN_RASTER_SHARE) return n;
      await letOthersRun();
    }
    return null;
  } finally {
    await task.destroy();
  }
}

/** Above zero, a figure probably shows the paper's method. */
export function coverScore(figure: PaperFigure, title: string): number {
  // Later sentences explain the figure, and can mention anything.
  const opening = figure.caption.split(/(?<=\.)\s|。/)[0];
  const method = /^(.{3,}?)\s*[:：]/.exec(title)?.[1].toLowerCase();
  let score = 0;
  if (STRONG.test(opening)) score += 3;
  if (WEAK.test(opening)) score += 1;
  // Naming the method only counts together with the rest. Plenty of results name it too.
  if (score > 0 && method && opening.toLowerCase().includes(method)) score += 1;
  if (RESULT.test(opening)) score -= 3;
  if (figure.width / figure.height > THIN_FIGURE) score -= 2;
  return score;
}

/**
 * The crop that best shows the method, else the first one. A figure the user removed is a bad
 * crop, so it's never used.
 */
export function pickCoverFigure(figures: PaperFigure[], title: string, hasFile: (file: string) => boolean): PaperFigure | undefined {
  const usable = [...figures].sort(byPosition).filter((f) => !f.excluded && hasFile(f.file));
  let best = usable[0];
  let bestScore = 0;
  for (const figure of usable) {
    const score = coverScore(figure, title);
    if (score > bestScore) {
      best = figure;
      bestScore = score;
    }
  }
  return best;
}

/** The chosen crop, else the whole page of the first figure, which is a good answer even if the user removed it, else page 1. */
export async function chooseCover(
  figures: PaperFigure[],
  title: string,
  hasFile: (file: string) => boolean,
  locate: () => Promise<number | null>,
): Promise<{ figure?: string; page: number }> {
  const sorted = [...figures].sort(byPosition);
  const crop = pickCoverFigure(figures, title, hasFile);
  if (crop) return { figure: crop.file, page: crop.page };
  if (sorted.length) return { page: sorted[0].page };
  return { page: (await locate().catch(() => null)) ?? 1 };
}
