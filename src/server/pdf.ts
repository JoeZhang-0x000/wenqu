import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));

export interface PdfExtract {
  pages: string[];
  title?: string;
  authors: string[];
  abstract?: string;
  year?: number;
}

interface Line {
  text: string;
  height: number;
  y: number;
}

const JUNK_TITLE = /^(\(?anonymous\)?|untitled|microsoft word|powerpoint|arxiv:|doi:|\S+\.(pdf|docx?|tex|dvi)$)/i;

/** Groups pdf.js text items into visual lines, in stream order. */
function toLines(items: any[]): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5];
    const height = item.height || Math.abs(item.transform[3]);
    if (!current || Math.abs(current.y - y) > Math.max(2, height * 0.5)) {
      if (current?.text.trim()) lines.push(current);
      current = { text: '', height: 0, y };
    }
    current.text += item.str;
    if (item.str.trim()) current.height = Math.max(current.height, height);
    if (item.hasEOL) {
      if (current.text.trim()) lines.push(current);
      current = null;
    }
  }
  if (current?.text.trim()) lines.push(current);
  return lines;
}

function joinLines(lines: Line[]): string {
  let out = '';
  for (const line of lines) {
    const text = line.text.trim();
    if (out.endsWith('-') && /^[a-z]/.test(text)) out = out.slice(0, -1) + text;
    else if (/[㐀-鿿]$/.test(out) && /^[㐀-鿿]/.test(text)) out += text;
    else out += (out ? '\n' : '') + text;
  }
  return out;
}

function guessFront(lines: Line[], infoTitle?: string): Pick<PdfExtract, 'title' | 'authors' | 'abstract' | 'year'> {
  const front = lines.slice(0, 60);
  const usable = front.filter((l) => l.text.trim().length > 3 && !/^(arxiv|preprint|published|proceedings)/i.test(l.text.trim()));
  const maxHeight = Math.max(0, ...usable.slice(0, 25).map((l) => l.height));
  const start = usable.findIndex((l) => l.height >= maxHeight * 0.98);

  let title: string | undefined;
  let authors: string[] = [];
  if (start >= 0) {
    let end = start;
    while (end + 1 < usable.length && usable[end + 1].height >= maxHeight * 0.9 && end - start < 3) end++;
    title = usable
      .slice(start, end + 1)
      .map((l) => l.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ');
    const after = usable.slice(end + 1, end + 6);
    const authorLines: string[] = [];
    for (const l of after) {
      if (/abstract|摘要|introduction/i.test(l.text)) break;
      authorLines.push(l.text.trim());
      if (authorLines.length === 2) break;
    }
    authors = authorLines
      .join(', ')
      .replace(/[∗*†‡§¶\d]/g, '')
      .split(/\s*(?:,|，|、|;|\band\b)\s*/)
      .map((a) => a.trim())
      .filter((a) => a.length > 1 && a.length < 40 && !/@|university|institute|department|大学|学院|研究院|lab/i.test(a))
      .slice(0, 12);
  }
  if (!title || title.length < 6) {
    title = infoTitle && !JUNK_TITLE.test(infoTitle.trim()) ? infoTitle.trim() : undefined;
  }

  const firstPage = lines.map((l) => l.text.trim()).join('\n');
  const abstractMatch = firstPage.match(
    /(?:abstract|摘\s*要)[\s.:：—-]*\n?([\s\S]{80,2400}?)(?:\n\s*(?:keywords?|index terms|关键词|1\.?\s+introduction|i\.\s+introduction|1\s+引言|一、)|$)/i,
  );
  const yearMatch = firstPage.match(/\b(19[89]\d|20[0-4]\d)\b/);
  return {
    title,
    authors,
    abstract: abstractMatch?.[1].replace(/\s*\n\s*/g, ' ').trim(),
    year: yearMatch ? Number(yearMatch[1]) : undefined,
  };
}

/** Opens a PDF in Node. Call `task.destroy()` when finished. */
export async function openPdf(data: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // In Node, pdf.js reads these with `fs`: they must be plain paths, and `file://` URLs silently yield no text.
  const dir = (name: string) => `${join(PDFJS_DIR, name)}/`;
  // Character maps are what make CJK-encoded PDFs extract as text rather than garbage.
  const task = pdfjs.getDocument({
    data,
    cMapUrl: dir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dir('standard_fonts'),
    wasmUrl: dir('wasm'),
    useSystemFonts: false,
    verbosity: 0,
    isEvalSupported: false,
  } as any);
  return { task, doc: await task.promise };
}

export async function extractPdf(data: Uint8Array): Promise<PdfExtract> {
  const { task, doc } = await openPdf(data);
  try {
    const pages: string[] = [];
    let firstLines: Line[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = toLines(content.items as any[]);
      if (n === 1) firstLines = lines;
      pages.push(joinLines(lines));
      page.cleanup();
    }
    const info: any = (await doc.getMetadata().catch(() => null))?.info;
    return { pages, ...guessFront(firstLines, typeof info?.Title === 'string' ? info.Title : undefined) };
  } finally {
    await task.destroy();
  }
}

/** Page-marked text, so that agents can cite pages as [p.N]. */
export function pageMarkedText(pages: string[], maxChars: number): { text: string; truncated: boolean } {
  let text = '';
  for (let i = 0; i < pages.length; i++) {
    const block = `\n[p.${i + 1}]\n${pages[i]}\n`;
    if (text.length + block.length > maxChars) {
      return { text: text + block.slice(0, Math.max(0, maxChars - text.length)), truncated: true };
    }
    text += block;
  }
  return { text, truncated: false };
}
