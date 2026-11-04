import { t } from '../shared/i18n.js';
import type { PaperMeta } from '../shared/types.js';
import type { Vault } from './vault.js';

const USER_AGENT = 'wenqu/0.1';
const MAX_PDF_BYTES = 200 * 1024 * 1024;

const NEW_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const OLD_ID = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/;
const HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org', 'alphaxiv.org', 'www.alphaxiv.org', 'ar5iv.org', 'ar5iv.labs.arxiv.org']);

/** Accepts a bare id, an `arXiv:` id, or a link to an arXiv page. Returns null for anything else. */
export function parseArxivInput(input: string): string | null {
  const text = input.trim();
  const bare = text.replace(/^arxiv:\s*/i, '');
  if (NEW_ID.test(bare) || OLD_ID.test(bare)) return bare;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.pdf$/i, '');
  const match = path.match(/^(?:abs|pdf|html|ps|format|html5)\/(.+)$/);
  const id = match?.[1];
  return id && (NEW_ID.test(id) || OLD_ID.test(id)) ? id : null;
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
const clean = (text: string | undefined) => (text === undefined ? undefined : decodeXml(text).replace(/\s+/g, ' ').trim());

export type ArxivMeta = Required<Pick<PaperMeta, 'title' | 'authors' | 'arxivId'>> & Pick<PaperMeta, 'year' | 'abstract'>;

/** Parses one entry from the arXiv Atom API. Returns null if the feed has none. */
export function parseArxivFeed(xml: string): ArxivMeta | null {
  const entry = tag(xml, 'entry');
  if (!entry) return null;
  const title = clean(tag(entry, 'title'));
  const arxivId = clean(tag(entry, 'id'))?.match(/abs\/(.+)$/)?.[1];
  if (!title || !arxivId) return null;
  const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)]
    .map((m) => clean(tag(m[1], 'name')))
    .filter((name): name is string => Boolean(name));
  const published = clean(tag(entry, 'published'));
  return {
    title,
    arxivId,
    authors,
    abstract: clean(tag(entry, 'summary')),
    year: published ? Number(published.slice(0, 4)) || undefined : undefined,
  };
}

async function request(url: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(180_000);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    const cause = (err as Error & { cause?: Error }).cause?.message ?? (err as Error).message;
    throw new Error(t('无法连接 arXiv：{cause}', { cause }));
  }
}

async function fetchMeta(id: string): Promise<ArxivMeta | null> {
  const res = await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(t('arXiv API 返回 {status}', { status: res.status }));
  return parseArxivFeed(await res.text());
}

async function fetchPdf(id: string): Promise<Buffer> {
  const res = await request(`https://arxiv.org/pdf/${id}`);
  if (res.status === 404) throw new Error(t('arXiv 上找不到 {id}', { id }));
  if (!res.ok || !res.body) throw new Error(t('下载 PDF 失败：HTTP {status}', { status: res.status }));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_PDF_BYTES) throw new Error(t('PDF 太大'));
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function importArxiv(vault: Vault, input: string) {
  const id = parseArxivInput(input);
  if (!id) throw new Error(t('这不是有效的 arXiv 链接或编号'));
  const existing = vault.findArxiv(id);
  if (existing) return { meta: existing, duplicate: true };

  // Metadata is a bonus: if only the API is down, the paper can still be imported.
  let meta: ArxivMeta | null = null;
  let metaLoaded = false;
  try {
    meta = await fetchMeta(id);
    metaLoaded = true;
  } catch {
    /* Falls back to what can be read from the PDF. */
  }
  if (metaLoaded && !meta) throw new Error(t('arXiv 上找不到 {id}', { id }));
  const pdf = await fetchPdf(id);
  return vault.importPdf(pdf, `${(meta?.arxivId ?? id).replace('/', '_')}.pdf`, meta ?? { arxivId: id });
}
