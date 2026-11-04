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

let thumbQueue: Promise<unknown> = Promise.resolve();

/** Renders a cover image one at a time, so a large library doesn't spawn a worker per card. */
export function renderThumb(paperId: string): Promise<Blob> {
  const run = async () => {
    const { pdfjs } = await loadPdfjs();
    const task = pdfjs.getDocument(documentOptions(`/api/papers/${paperId}/pdf`) as any);
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 480 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, viewport } as any).promise;
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('无法生成封面')))), 'image/jpeg', 0.82),
      );
    } finally {
      await task.destroy();
    }
  };
  const result = thumbQueue.then(run, run);
  thumbQueue = result.catch(() => {});
  return result;
}
