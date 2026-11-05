import type { PaperFigure } from '../shared/types.js';
import { CAPTION, byPosition, layoutLines, letOthersRun } from './figures.js';
import { loadPdfjs, openPdf } from './pdf.js';

/**
 * Bump only when the choice below changes, so that every existing cover gets chosen again.
 * A cover from before this marker existed counts as older than any version.
 */
export const COVER_VERSION = 1;

/** `cover.json`, next to `thumb.jpg`. */
export type CoverMarker = { version: number } & ({ kind: 'figure' | 'page'; page: number } | { kind: 'failed' });

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

/**
 * Crop of the first figure, else the whole page holding it, else page 1.
 * A figure the user removed is a bad crop, so it's skipped, though its page is still a good answer.
 */
export async function chooseCover(
  figures: PaperFigure[],
  hasFile: (file: string) => boolean,
  locate: () => Promise<number | null>,
): Promise<{ figure?: string; page: number }> {
  const sorted = [...figures].sort(byPosition);
  const crop = sorted.find((f) => !f.excluded && hasFile(f.file));
  if (crop) return { figure: crop.file, page: crop.page };
  if (sorted.length) return { page: sorted[0].page };
  return { page: (await locate().catch(() => null)) ?? 1 };
}
