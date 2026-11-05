import { t } from '../../src/shared/i18n';

/** pdf.js is heavy, so it loads on first use. The viewer module expects a global `pdfjsLib`. */
let loading: Promise<{ pdfjs: typeof import('pdfjs-dist'); viewer: any }> | undefined;

export function loadPdfjs() {
  return (loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.min.mjs';
    (globalThis as any).pdfjsLib = pdfjs;
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
    return { pdfjs, viewer };
  })());
}

export const documentOptions = (url: string) => ({
  url,
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
});

const jpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('无法生成封面')))), 'image/jpeg', quality),
  );

/** A whole page, which the card shows from the top. */
export async function renderPageCover(paperId: string, pageNumber: number): Promise<Blob> {
  const { pdfjs } = await loadPdfjs();
  const task = pdfjs.getDocument(documentOptions(`/api/papers/${paperId}/pdf`) as any);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 480 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, viewport } as any).promise;
    return await jpeg(canvas, 0.82);
  } finally {
    await task.destroy();
  }
}

/**
 * A cropped figure, centred on a white image with the card's proportions. The white is part
 * of the image, so a card shows this and a whole page the same way and nothing gets cut off.
 */
export async function renderFigureCover(paperId: string, file: string): Promise<Blob> {
  const image = new Image();
  image.src = `/api/papers/${paperId}/figures/${file}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const margin = canvas.width * 0.05;
  const scale = Math.min((canvas.width - margin * 2) / image.naturalWidth, (canvas.height - margin * 2) / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  // Line art shows JPEG artefacts sooner than a page of text does.
  return jpeg(canvas, 0.9);
}
