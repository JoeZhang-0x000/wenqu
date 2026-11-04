import { t } from '../shared/i18n.js';
import type { ArxivHit, ArxivLookup, ArxivMeta } from '../shared/types.js';
import { withoutArxivVersion, type Vault } from './vault.js';

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

function parseEntry(entry: string): ArxivMeta | null {
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

/** Parses every entry in an arXiv Atom feed. */
export function parseArxivEntries(xml: string): ArxivMeta[] {
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => parseEntry(m[1])).filter((e): e is ArxivMeta => Boolean(e));
}

/** Parses one entry from the arXiv Atom API. Returns null if the feed has none. */
export function parseArxivFeed(xml: string): ArxivMeta | null {
  return parseArxivEntries(xml)[0] ?? null;
}

async function request(url: string, signal?: AbortSignal, timeoutMs = 180_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
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

/** arXiv asks API clients to leave three seconds between requests. */
const API_SPACING_MS = 3000;
let nextApiSlot = 0;

export function resetApiPacing(): void {
  nextApiSlot = 0;
}

/** Queues the call for its turn, which also spaces out the imports in a batch. */
async function apiRequest(url: string, timeoutMs?: number): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, nextApiSlot - now);
  nextApiSlot = Math.max(now, nextApiSlot) + API_SPACING_MS;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  return request(url, undefined, timeoutMs);
}

async function fetchMeta(id: string): Promise<ArxivMeta | null> {
  const res = await apiRequest(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
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

/** A preview that takes longer than this is no longer worth waiting for. */
const LOOKUP_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * What each input refers to, before anything is downloaded. The metadata is only a
 * preview, so when arXiv can't be reached the ids still come back and can be imported.
 */
export async function lookupArxiv(vault: Vault, inputs: string[]): Promise<ArxivLookup[]> {
  const papers = vault.listPapers();
  const results: ArxivLookup[] = inputs.map((input) => {
    const id = parseArxivInput(input);
    return { input, id, paperId: id ? vault.findArxiv(id, papers)?.id : undefined, status: id ? 'unknown' : 'invalid' };
  });
  const ids = [...new Set(results.flatMap((r) => (r.id ? [r.id] : [])))];
  if (!ids.length) return results;
  try {
    const res = await apiRequest(`https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`, LOOKUP_TIMEOUT_MS);
    if (!res.ok) return results;
    const entries = parseArxivEntries(await res.text());
    for (const result of results) {
      if (!result.id) continue;
      // Two versions of a paper can be asked for together, and arXiv picks the order.
      const base = withoutArxivVersion(result.id);
      const entry = entries.find((e) => e.arxivId === result.id) ?? entries.find((e) => withoutArxivVersion(e.arxivId) === base);
      result.status = entry ? 'found' : 'missing';
      if (entry) result.meta = entry;
    }
  } catch {
    /* Only the preview is lost. */
  }
  return results;
}

const FIELDED_QUERY = /\b(?:ti|au|abs|co|jr|cat|rn|id|all):/;

/** Turns plain words into what the API expects, where every word must match. Fielded queries pass through. */
export function arxivSearchQuery(text: string): string {
  const query = text.trim();
  if (FIELDED_QUERY.test(query)) return query;
  const terms = query.match(/"[^"]+"|\S+/g) ?? [];
  return terms.map((term) => `all:${term}`).join(' AND ');
}

export async function searchArxiv(
  vault: Vault,
  query: string,
  options: { maxResults?: number; sort?: 'relevance' | 'recent' } = {},
): Promise<ArxivHit[]> {
  const params = new URLSearchParams({
    search_query: arxivSearchQuery(query),
    start: '0',
    max_results: String(options.maxResults ?? 10),
    sortBy: options.sort === 'recent' ? 'submittedDate' : 'relevance',
    sortOrder: 'descending',
  });
  const res = await apiRequest(`https://export.arxiv.org/api/query?${params}`, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(t('arXiv API 返回 {status}', { status: res.status }));
  const papers = vault.listPapers();
  return parseArxivEntries(await res.text()).map((entry) => ({
    ...entry,
    paperId: vault.findArxiv(withoutArxivVersion(entry.arxivId), papers)?.id,
  }));
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
