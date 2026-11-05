/**
 * What a repository link may look like. Owners and names end up as arguments to git and in
 * paths on disk, and they can come from a paper, a paste or a hand-edited meta.json, so
 * everything that uses one goes through these checks first.
 */

export interface RepoRef {
  owner: string;
  name: string;
  /** The commit everything is read from and cited at. */
  sha: string;
}

export interface PaperRepo extends RepoRef {
  /** Off means the reader chat behaves as if no repository were linked. */
  enabled: boolean;
}

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const NAME = /^[a-z0-9._][a-z0-9._-]{0,99}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isRepoOwner = (value: unknown): value is string => typeof value === 'string' && OWNER.test(value);

export const isRepoName = (value: unknown): value is string =>
  typeof value === 'string' && NAME.test(value) && value !== '.' && !value.includes('..') && !/\.git$/i.test(value);

export const isCommitSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);

/** Accepts only `https://github.com/<owner>/<repo>`, with an optional `.git` or trailing slash. */
export function parseRepoUrl(url: unknown): { owner: string; name: string } | null {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match || !isRepoOwner(match[1]) || !isRepoName(match[2])) return null;
  return { owner: match[1], name: match[2] };
}

export const repoUrl = (repo: { owner: string; name: string }) => `https://github.com/${repo.owner}/${repo.name}`;

export const repoLabel = (repo: { owner: string; name: string }) => `${repo.owner}/${repo.name}`;

export const shortSha = (sha: string) => sha.slice(0, 7);

/** `meta.json` can be edited by hand, so a link is only ever read through this. Anything off means no link. */
export function readPaperRepo(value: unknown): PaperRepo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { owner, name, sha, enabled } = value as Record<string, unknown>;
  if (!isRepoOwner(owner) || !isRepoName(name) || !isCommitSha(sha)) return undefined;
  return { owner, name, sha, enabled: enabled === true };
}

/** The same for the repository recorded on a chat message. */
export function readRepoRef(value: unknown): RepoRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { owner, name, sha } = value as Record<string, unknown>;
  return isRepoOwner(owner) && isRepoName(name) && isCommitSha(sha) ? { owner, name, sha } : undefined;
}

const MAX_PATH_CHARS = 1024;

/**
 * A path inside a repository, as a model might write it. A leading `-` could become an option,
 * and a `..` or `.` segment has no business in a tree lookup. The root is the empty string.
 */
export function isRepoPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('-')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('-'));
}

/** A link to these lines on GitHub, at the commit the answer was written from. */
export function blobUrl(repo: RepoRef, path: string, start?: number, end?: number): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const lines = start ? `#L${start}${end && end > start ? `-L${end}` : ''}` : '';
  return `${repoUrl(repo)}/blob/${repo.sha}/${encoded}${lines}`;
}

/** The citation form the agent is told to use, such as [code:src/model.py:10-20]. */
const CODE_CITATION = /\[code:\s*([^\]\[\n:]+?)(?::L?(\d{1,7})(?:\s*[-–]\s*L?(\d{1,7}))?)?\s*\]/g;

export interface CodeCitation {
  path: string;
  start?: number;
  end?: number;
  url: string;
  label: string;
}

/** Null means it isn't a citation the app can link to, so it stays plain text. */
export function codeCitation(repo: RepoRef, path: string, start?: string, end?: string): CodeCitation | null {
  const clean = path.trim();
  if (!isRepoPath(clean)) return null;
  const from = start ? Number(start) : undefined;
  const to = end ? Number(end) : undefined;
  if (from === 0 || (from && to && to < from)) return null;
  const lines = from ? `:${from}${to && to > from ? `-${to}` : ''}` : '';
  return { path: clean, start: from, end: to, url: blobUrl(repo, clean, from, to), label: `${clean}${lines}` };
}

/** Replaces each citation that can be linked, and leaves the rest of the text alone. */
export function replaceCodeCitations(text: string, repo: RepoRef, render: (citation: CodeCitation) => string): string {
  return text.replace(CODE_CITATION, (whole, path: string, start?: string, end?: string) => {
    const citation = codeCitation(repo, path, start, end);
    return citation ? render(citation) : whole;
  });
}
