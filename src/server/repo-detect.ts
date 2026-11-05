import type { RepoCandidate, RepoHint } from '../shared/types.js';
import { isRepoName, isRepoOwner, repoUrl } from '../shared/repo.js';
import { openPdf } from './pdf.js';

/**
 * Finds GitHub repositories a paper mentions. This reads only what's already on disk: nothing
 * here touches the network, and nothing is fetched until the user picks one.
 */

/** A link annotation: the URL behind some text in the PDF, which may never appear in the text itself. */
export interface PdfLink {
  url: string;
  page: number;
  /** The visible text around the link, when it could be located. */
  context?: string;
}

/** Bump when reading links changes, so that cached results are read again. */
export const REPO_LINKS_VERSION = 1;

/** Top-level pages on github.com that are not owners. */
const NOT_OWNERS = new Set(
  `about account apps blog codespaces collections contact customer-stories dashboard enterprise events explore features
  git-guides issues join login logout marketplace mobile new nonprofit notifications orgs organizations organization
  pricing pulls readme resources search security settings site sitemap solutions sponsors stars team topics trending
  users watching wiki`.split(/\s+/),
);

const URL_START = /(?<![\w.-])(?:www\.)?github\s?\.\s?com\s?[/:]\s*/gi;
const PATH_CHARS = /^[\w.\-/]+/;
const MAX_CANDIDATES = 12;

/** A likely answer needs more than being mentioned early on. */
const LIKELY_SCORE = 6;

interface Mention {
  owner: string;
  name: string;
  /** Whatever followed the repository in the URL, such as "issues/12". */
  rest: string;
  /** Offset in the page's text. */
  index: number;
  length: number;
}

const stripEnd = (text: string) => text.replace(/[.,;:!?'"’”)\]}>_*-]+$/, '');

/** The piece of a URL at the start of `line`, and whether anything else follows it on that line. */
function urlPieceAt(line: string): { piece: string; alone: boolean } {
  const piece = PATH_CHARS.exec(line)?.[0] ?? '';
  return { piece, alone: !line.slice(piece.length).trim() };
}

/**
 * Reads a URL's path from `text`, joining it across line breaks where PDF extraction split it.
 * A break is only crossed where the URL can't have ended, because otherwise the next
 * word of the sentence would become part of the repository's name.
 */
function readPath(text: string, from: number): { path: string; end: number } {
  let path = '';
  let at = from;
  for (let crossed = 0; crossed < 3; crossed++) {
    const piece = PATH_CHARS.exec(text.slice(at))?.[0] ?? '';
    path += piece;
    at += piece.length;
    const newline = /^[ \t]*\r?\n[ \t]*/.exec(text.slice(at));
    if (!newline) break;
    const next = text.slice(at + newline[0].length).split('\n', 1)[0];
    const { piece: nextPiece, alone } = urlPieceAt(next);
    if (!nextPiece) break;
    const slashes = (path.match(/\//g) ?? []).length;
    // A full stop isn't here: it far more often ends the sentence than continues the name.
    const unfinished = !path || /[-_/]$/.test(path);
    // github.com/own<break>er/name: the next piece has to supply the slash.
    const ownerOnly = slashes === 0 && nextPiece.includes('/');
    // github.com/owner/na<break>me. Only when the line holds nothing else, as a footnote's URL does,
    // and it doesn't look like a heading, a page number or the end of a sentence.
    const wrappedName = slashes === 1 && alone && /^[a-z_-]/.test(nextPiece) && !nextPiece.endsWith('.') && nextPiece.length < 40;
    if (!unfinished && !ownerOnly && !wrappedName) break;
    at += newline[0].length;
  }
  return { path, end: at };
}

function toMention(path: string): Pick<Mention, 'owner' | 'name' | 'rest'> | null {
  const [owner, rawName, ...rest] = stripEnd(path).split('/');
  if (!owner || !rawName) return null;
  const name = stripEnd(rawName.replace(/\.git$/i, ''));
  if (NOT_OWNERS.has(owner.toLowerCase()) || !isRepoOwner(owner) || !isRepoName(name)) return null;
  return { owner, name, rest: rest.join('/') };
}

function mentionsIn(text: string): Mention[] {
  const out: Mention[] = [];
  for (const match of text.matchAll(URL_START)) {
    const from = match.index + match[0].length;
    const { path, end } = readPath(text, from);
    const mention = toMention(path);
    if (mention) out.push({ ...mention, index: match.index, length: end - match.index });
  }
  return out;
}

/** Every repository a piece of text names. */
export function extractRepoMentions(text: string): { owner: string; name: string }[] {
  return mentionsIn(text).map(({ owner, name }) => ({ owner, name }));
}

/** The repository a link points at, or null if it isn't one. */
export function repoFromLink(url: string): { owner: string; name: string } | null {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(url.trim());
  if (!match) return null;
  return toMention(match[1].split(/[?#]/, 1)[0]);
}

// Reading a mention's context. English and Chinese, since both kinds of paper turn up.
const OWN_CODE =
  /\b(?:our|the)\s+(?:source\s+)?(?:code|implementation|prototype|artifacts?)\b|\bsource\s+code\b|\b(?:code|implementation|artifacts?|repository|software)\s+(?:is|are|will\s+be|has\s+been)?\s*(?:publicly\s+|freely\s+|openly\s+)?(?:available|released|open-?sourced|hosted|published)\b|\bopen[-\s]?sourc(?:e|ed|ing)\b|\b(?:code|data|artifact)\s+availability\b|\bwe\s+(?:release|publish|open-?source|make|provide)\b|\bavailable\s+(?:at|on|from)\b|\bcode\s*:|开源|代码(?:已|在|见|地址|可)|本文(?:的)?(?:代码|实现)/i;
const SOMEONE_ELSES =
  /\b(?:built|build|based|implemented|running|runs)\s+(?:up)?on\b|\bon\s+top\s+of\b|\bbaselines?\b|\bwe\s+(?:use|used|adopt|adopted|leverage|integrate|extend|modify|modified|fork)\b|\busing\b|\bextends?\b|\bforked\b|\blibrar(?:y|ies)\b|\bdependenc(?:y|ies)\b|\bcompared?\s+(?:to|with|against)\b|\bexisting\b|基于|使用了?|采用|对比/i;
const REFERENCES_HEADING = /^\s*(?:\d+\.?\s+|[ivx]+\.\s+)?(?:references|bibliography|参考文献)\s*$/gim;
const SENTENCE_END = /[.!?。！？]\s/;

/** Words too common in titles to say that a repository belongs to this paper. */
const COMMON_WORDS = new Set(
  `about across agent agents analysis approach attention based beyond cache caching code data deep design efficient emerging
  empirical evaluation fast framework from generation generative graph high hybrid inference information language large learning
  linear llms long memory method methods mixture model models network networks neural novel open optimization performance prefix
  scalable search serving study survey system systems task their through towards training transformer transformers using with
  flash ultra lang`.split(/\s+/),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter(Boolean);

/** The name a paper gives its own system, usually in front of a colon, and any unusual words after it. */
function titleWords(title: string): { system?: string; others: Set<string> } {
  const colon = /^\s*([^:：—–]{2,40})\s*[:：—–]/.exec(title);
  const lead = colon ? words(colon[1]) : [];
  const system = lead.length >= 1 && lead.length <= 3 ? lead[0] : undefined;
  const others = new Set(words(title).filter((w) => w.length >= 4 && !COMMON_WORDS.has(w) && w !== system));
  return { system, others };
}

/** How strongly a repository's name says it belongs to the paper with this title. */
function nameMatch(name: string, title: { system?: string; others: Set<string> }): number {
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = words(name);
  const system = title.system;
  if (system && system.length >= 3 && !COMMON_WORDS.has(system)) {
    if (joined === system || parts.includes(system)) return 8;
    if (system.length >= 4 && joined.includes(system)) return 6;
  }
  if (title.others.has(joined)) return 6;
  return parts.some((part) => title.others.has(part)) ? 3 : 0;
}

interface Reading {
  score: number;
  hints: Set<RepoHint>;
}

/** What one mention says, from where it sits and what's written around it. */
function readMention(page: number, around: { before: string; after: string }, inReferences: boolean, rest: string): Reading {
  const hints = new Set<RepoHint>();
  let score = 0;
  if (inReferences) {
    score -= 6;
    hints.add('references');
  } else {
    // A neighbouring sentence may announce the code, such as a heading just before the URL.
    if (OWN_CODE.test(`${around.before} ${around.after}`)) {
      score += 6;
      hints.add('context');
    }
    // But saying what was built on only counts within the sentence, or one mention taints the next.
    const sentence = `${around.before.split(SENTENCE_END).pop()} ${around.after.split(SENTENCE_END)[0]}`;
    if (SOMEONE_ELSES.test(sentence)) {
      score -= 3;
      hints.add('dependency');
    }
    if (page <= 2) {
      score += 2;
      hints.add('early');
    }
  }
  // Pointing at someone's issue or pull request is rarely how a paper names its own code.
  if (/^(?:issues|pull|discussions|commit)\b/.test(rest)) score -= 2;
  return { score, hints };
}

/** Candidates that differ only by hyphens or case are one repository that extraction mangled. */
const repoKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase().replace(/-/g, '');

/**
 * Orders what a paper mentions, most likely to be its own code first. Papers list their
 * dependencies and baselines more often than their own code, and may not link their code at
 * all, so this is only ever a suggestion: `likely` means worth checking, nothing more.
 */
export function rankRepoCandidates(input: { title: string; pages: string[]; links?: PdfLink[] }): RepoCandidate[] {
  const title = titleWords(input.title);
  const lastHeading = input.pages.reduce<{ page: number; index: number } | undefined>((found, text, i) => {
    const matches = [...text.matchAll(REFERENCES_HEADING)];
    return matches.length ? { page: i, index: matches[matches.length - 1].index } : found;
  }, undefined);
  const inReferences = (page: number, index: number) => Boolean(lastHeading && (page > lastHeading.page || (page === lastHeading.page && index >= lastHeading.index)));

  const found = new Map<string, { owner: string; name: string; page: number; order: number; linked: boolean; mentions: number; best: Reading }>();
  const note = (repo: { owner: string; name: string }, page: number, reading: Reading, linked: boolean) => {
    const key = repoKey(repo.owner, repo.name);
    const entry = found.get(key);
    if (!entry) {
      found.set(key, { owner: repo.owner, name: repo.name, page, order: found.size, linked, mentions: linked ? 0 : 1, best: reading });
      return;
    }
    // A link is the URL as written, while a line break in the text may have lost a hyphen.
    if (linked && !entry.linked) Object.assign(entry, { owner: repo.owner, name: repo.name, linked });
    if (!linked) entry.mentions++;
    entry.page = Math.min(entry.page, page);
    if (reading.score > entry.best.score) entry.best = reading;
  };

  input.pages.forEach((text, i) => {
    for (const m of mentionsIn(text)) {
      const around = { before: text.slice(Math.max(0, m.index - 160), m.index), after: text.slice(m.index + m.length, m.index + m.length + 60) };
      note(m, i + 1, readMention(i + 1, around, inReferences(i, m.index), m.rest), false);
    }
  });
  for (const link of input.links ?? []) {
    const repo = repoFromLink(link.url);
    if (!repo) continue;
    const at = link.context ? (input.pages[link.page - 1] ?? '').indexOf(link.context.slice(0, 40)) : -1;
    const references = at >= 0 ? inReferences(link.page - 1, at) : Boolean(lastHeading && link.page - 1 > lastHeading.page);
    const rest = link.url.split(/github\.com\//i)[1]?.split('/').slice(2).join('/') ?? '';
    note(repo, link.page, readMention(link.page, { before: link.context ?? '', after: '' }, references, rest), true);
  }

  return [...found.values()]
    .map((entry) => {
      const match = nameMatch(entry.name, title);
      const hints = new Set(entry.best.hints);
      if (match >= 6) hints.add('name');
      return { ...entry, hints, score: entry.best.score + match + Math.max(0, Math.min(entry.mentions - 1, 2)) };
    })
    .sort((a, b) => b.score - a.score || a.page - b.page || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .map(
      ({ owner, name, page, score, hints }): RepoCandidate => ({
        owner,
        name,
        url: repoUrl({ owner, name }),
        page,
        likely: score >= LIKELY_SCORE,
        hints: [...hints],
      }),
    );
}

/**
 * Reads the link annotations of a PDF, for papers that hide the URL behind linked text.
 * Only links to github.com are kept, along with the words around them.
 */
export async function readPdfLinks(data: Uint8Array): Promise<PdfLink[]> {
  const { task, doc } = await openPdf(data);
  try {
    const links: PdfLink[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const annotations: any[] = await page.getAnnotations({ intent: 'display' });
      const github = annotations.filter((a) => a.subtype === 'Link' && typeof a.url === 'string' && /github\.com\//i.test(a.url));
      if (github.length) {
        const content = await page.getTextContent();
        for (const annotation of github) links.push({ url: annotation.url, page: n, context: textNear(content.items as any[], annotation.rect) });
      }
      page.cleanup();
    }
    return links;
  } finally {
    await task.destroy();
  }
}

/** The text of the lines a link sits on, plus the one above it, in the order the PDF draws them. */
function textNear(items: any[], rect: number[] | undefined): string | undefined {
  if (!rect) return undefined;
  const [, bottom, , top] = rect;
  const height = Math.max(top - bottom, 6);
  const near = items.filter((item) => {
    if (typeof item.str !== 'string' || !item.transform) return false;
    const y = item.transform[5];
    return y >= bottom - height * 1.6 && y <= top + height * 1.6;
  });
  const text = near.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 400) : undefined;
}
