import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../shared/i18n.js';
import { isCommitSha, isRepoName, isRepoOwner, isRepoPath, repoUrl, type RepoRef } from '../shared/repo.js';

/**
 * Clones of linked repositories, and read-only access to them.
 *
 * A repository is untrusted, like a paper. Clones are bare, so there's no working tree where a
 * symlink or a hook could do anything, and files are only ever read out of git's object store.
 * Every call uses `spawn` with no shell, and the owner, name, commit and paths are checked
 * before they get anywhere near an argument.
 */

const CLONE_TIMEOUT_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 20_000;
const KILL_AFTER_MS = 3_000;
const MAX_CLONE_BYTES = 500 * 1024 * 1024;
const SIZE_CHECK_MS = 1_000;
const MAX_ERROR_CHARS = 200;

/** What one tool call can return to the agent. */
export const MAX_RESULT_CHARS = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_LINE_CHARS = 1_000;
const MAX_LISTED_ENTRIES = 500;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_LINES = 200;
const MAX_SEARCH_LINE_CHARS = 300;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_CHARS = 200;
const BINARY_SNIFF_BYTES = 8_000;

/** Git variables that would point these commands at some other repository. */
const LOCAL_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_QUARANTINE_PATH', 'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE', 'GIT_WORK_TREE',
];

/** The caller's environment, so proxy settings apply, without anything that could wait for a person. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCAL_GIT_ENV) delete env[name];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    // Credential helpers may otherwise open a window for a private or missing repository.
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    LC_ALL: 'C',
  };
}

interface GitOptions {
  gitDir?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Stops reading once this much has arrived, and reports that it did. */
  maxBytes?: number;
  /** Called as often as git writes to stderr. */
  onStderr?(text: string): void;
  /** Exit codes other than 0 that aren't failures. */
  okCodes?: number[];
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  cut: boolean;
  timedOut: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** Runs git directly, never through a shell. Hooks and file monitors are off, whatever the user's config says. */
function git(args: string[], options: GitOptions): Promise<GitResult> {
  const full = [
    '--literal-pathspecs',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null',
    ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
    ...args,
  ];
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn('git', full, { env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let timedOut = false;
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      if (killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // Something that inherited the pipes can keep them open, so don't wait for them.
        finish(null);
      }, KILL_AFTER_MS);
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error(t('已取消')));
        return;
      }
      if (error) {
        reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new GitError(t('没有找到 git，请先安装 git')) : error);
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, code, cut, timedOut });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (cut) return;
      const room = options.maxBytes === undefined ? chunk.length : options.maxBytes - size;
      chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      size += Math.min(room, chunk.length);
      if (options.maxBytes !== undefined && size >= options.maxBytes) {
        cut = true;
        stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Only the end says what went wrong, so an endless stream of progress can't grow this.
      stderr = (stderr + text).slice(-4_000);
      options.onStderr?.(text);
    });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

const failed = (result: GitResult, ok: number[] = []) => !result.cut && result.code !== 0 && !ok.includes(result.code ?? -1);

function dirSize(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(child);
      else if (entry.isFile()) total += statSync(child).size;
    } catch {
      /* git moves its temporary files around while cloning. */
    }
  }
  return total;
}

/** A readable reason, because the whole of git's output means little to most people. */
function cloneError(repo: { owner: string; name: string }, stderr: string, timedOut: boolean): GitError {
  const label = `${repo.owner}/${repo.name}`;
  if (timedOut) return new GitError(t('拉取 {repo} 超时，请检查网络或代理后重试', { repo: label }), stderr, true);
  if (/not found|could not read username|terminal prompts disabled|authentication failed|error: 40[134]|returned error: 40[134]/i.test(stderr)) {
    return new GitError(t('找不到 {repo}，它可能不存在或是私有仓库', { repo: label }), stderr);
  }
  if (/could not resolve|failed to connect|connection (?:timed out|refused|reset)|couldn't connect|unable to access|ssl|tls|proxy|network/i.test(stderr)) {
    return new GitError(t('无法连接 GitHub，请检查网络或代理后重试'), stderr);
  }
  const line = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const clean = line.replace(/\/\/[^/@\s]+@/g, '//').slice(0, MAX_ERROR_CHARS);
  return new GitError(t('无法拉取 {repo}：{error}', { repo: label, error: clean || t('未知错误') }), stderr);
}

const goneMessage = (repo: { owner: string; name: string }) => t('{repo} 里已经没有这个提交', { repo: `${repo.owner}/${repo.name}` });

export interface RepoStoreOptions {
  /** Where clones live. */
  root: string;
  /** Where to fetch from. Tests point this at a local fixture so that they never touch the network. */
  cloneUrl?(repo: { owner: string; name: string }): string;
  /** Which transports git may use. */
  protocols?: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** Keyed by owner and name, then commit, so papers pinned to different commits don't disturb each other. */
export class RepoStore {
  private swept = false;

  constructor(private options: RepoStoreOptions) {}

  private get tempRoot() {
    return join(this.options.root, '.tmp');
  }

  private ownerNameDir(repo: { owner: string; name: string }): string {
    if (!isRepoOwner(repo.owner) || !isRepoName(repo.name)) throw new Error(t('仓库地址无效'));
    // GitHub ignores case, and so may this disk.
    return join(this.options.root, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);
  }

  private cloneDir(repo: RepoRef): string {
    if (!isCommitSha(repo.sha)) throw new Error(t('提交记录无效'));
    return join(this.ownerNameDir(repo), repo.sha);
  }

  has(repo: RepoRef): boolean {
    return existsSync(join(this.cloneDir(repo), 'HEAD'));
  }

  reader(repo: RepoRef): RepoReader {
    return new RepoReader(this.cloneDir(repo), repo.sha);
  }

  private url(repo: { owner: string; name: string }): string {
    return this.options.cloneUrl ? this.options.cloneUrl(repo) : `${repoUrl(repo)}.git`;
  }

  private protocolArgs(): string[] {
    const allowed = this.options.protocols ?? ['https'];
    return ['-c', 'protocol.allow=never', ...allowed.flatMap((p) => ['-c', `protocol.${p}.allow=always`])];
  }

  /** Clones in progress are only ever in here, so the first use clears what a killed run left behind. */
  private newTempDir(): string {
    mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    if (!this.swept) {
      this.swept = true;
      for (const name of readdirSync(this.tempRoot)) rmSync(join(this.tempRoot, name), { recursive: true, force: true });
    }
    return join(this.tempRoot, randomBytes(8).toString('hex'));
  }

  /** Runs one fetch into a temporary directory, watching its size. Nothing outside it is touched. */
  private async fetchInto(
    repo: { owner: string; name: string },
    temp: string,
    run: (onStderr: (text: string) => void, signal: AbortSignal) => Promise<GitResult>,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const maxBytes = this.options.maxBytes ?? MAX_CLONE_BYTES;
    const stopper = new AbortController();
    let tooBig = false;
    const onAbort = () => stopper.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const watcher = setInterval(() => {
      if (dirSize(temp) > maxBytes) {
        tooBig = true;
        stopper.abort();
      }
    }, SIZE_CHECK_MS);
    const onStderr = (text: string) => {
      const percent = /Receiving objects:\s+(\d+)%/.exec(text.split('\r').filter(Boolean).pop() ?? '');
      if (percent) onProgress?.(Number(percent[1]));
    };
    const tooBigError = () =>
      new GitError(t('{repo} 太大（超过 {size} MB），没有拉取', { repo: `${repo.owner}/${repo.name}`, size: Math.round(maxBytes / 1024 / 1024) }));
    try {
      const result = await run(onStderr, stopper.signal);
      if (dirSize(temp) > maxBytes) throw tooBigError();
      if (result.timedOut || failed(result)) throw cloneError(repo, result.stderr, result.timedOut);
    } catch (err) {
      if (tooBig) throw tooBigError();
      throw err;
    } finally {
      clearInterval(watcher);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Moves a finished clone into place in one step, so a clone either exists whole or not at all. */
  private adopt(temp: string, repo: RepoRef): void {
    const target = this.cloneDir(repo);
    if (existsSync(join(target, 'HEAD'))) return;
    mkdirSync(this.ownerNameDir(repo), { recursive: true, mode: 0o700 });
    rmSync(target, { recursive: true, force: true });
    renameSync(temp, target);
  }

  /** Fetches the default branch's latest commit. Failing or canceling leaves nothing behind. */
  async clone(repo: { owner: string; name: string }, opts: { signal?: AbortSignal; onProgress?(percent: number): void } = {}): Promise<RepoRef> {
    this.ownerNameDir(repo);
    const temp = this.newTempDir();
    try {
      await this.fetchInto(
        repo,
        temp,
        (onStderr, signal) =>
          git(
            [
              ...this.protocolArgs(),
              'clone', '--bare', '--depth', '1', '--single-branch', '--no-tags', '--template=', '--progress', '--',
              this.url(repo), temp,
            ],
            { timeoutMs: this.options.timeoutMs ?? CLONE_TIMEOUT_MS, signal, onStderr },
          ),
        opts.onProgress,
        opts.signal,
      );
      const head = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { gitDir: temp, timeoutMs: READ_TIMEOUT_MS, signal: opts.signal });
      const sha = head.stdout.toString('utf8').trim();
      if (head.code !== 0 || !isCommitSha(sha)) throw new GitError(t('{repo} 是空仓库', { repo: `${repo.owner}/${repo.name}` }), head.stderr);
      const pinned = { owner: repo.owner, name: repo.name, sha };
      this.adopt(temp, pinned);
      return pinned;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** Fetches one recorded commit again, as on a machine that has the vault but not the clone. */
  async restore(repo: RepoRef, opts: { signal?: AbortSignal; onProgress?(percent: number): void } = {}): Promise<void> {
    this.cloneDir(repo);
    const temp = this.newTempDir();
    try {
      await this.fetchInto(
        repo,
        temp,
        async (onStderr, signal) => {
          const init = await git(['init', '--bare', '--quiet', '--template=', '--', temp], { timeoutMs: READ_TIMEOUT_MS, signal });
          if (failed(init)) return init;
          return git(
            [
              ...this.protocolArgs(),
              'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--progress', '--',
              this.url(repo), repo.sha,
            ],
            { gitDir: temp, timeoutMs: this.options.timeoutMs ?? CLONE_TIMEOUT_MS, signal, onStderr },
          );
        },
        opts.onProgress,
        opts.signal,
      ).catch((err: unknown) => {
        if (err instanceof GitError && /not our ref|couldn't find remote ref|no such remote ref/i.test(err.stderr)) throw new GitError(goneMessage(repo), err.stderr);
        throw err;
      });
      const check = await git(['rev-parse', '--verify', '--quiet', `${repo.sha}^{commit}`], { gitDir: temp, timeoutMs: READ_TIMEOUT_MS, signal: opts.signal });
      if (check.code !== 0) throw new GitError(goneMessage(repo), check.stderr);
      this.adopt(temp, repo);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** Deletes this repository's clones that nothing needs any more. */
  release(repo: { owner: string; name: string }, keep: string[]): void {
    const dir = this.ownerNameDir(repo);
    if (!existsSync(dir)) return;
    for (const sha of readdirSync(dir)) {
      if (isCommitSha(sha) && !keep.includes(sha)) rmSync(join(dir, sha), { recursive: true, force: true });
    }
    if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    const ownerDir = join(this.options.root, repo.owner.toLowerCase());
    if (existsSync(ownerDir) && !readdirSync(ownerDir).length) rmSync(ownerDir, { recursive: true, force: true });
  }
}

/** Thrown for a request the agent can correct, and shown to it rather than to the user. */
export class RepoToolError extends Error {}

function clip(text: string, max: number, note: string): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${note}]` : text;
}

interface TreeEntry {
  mode: string;
  type: string;
  size: string;
  path: string;
}

function parseTree(raw: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const row of raw.split('\0')) {
    const match = /^(\d+) (\w+) [0-9a-f]+\s+(\S+)\t([\s\S]+)$/.exec(row);
    if (match) entries.push({ mode: match[1], type: match[2], size: match[3], path: match[4] });
  }
  return entries;
}

/** Looks only inside one clone, at one commit. Which repository that is isn't up to the caller's caller. */
export class RepoReader {
  constructor(
    private gitDir: string,
    private sha: string,
  ) {}

  private run(args: string[], options: Partial<GitOptions> = {}): Promise<GitResult> {
    if (!existsSync(join(this.gitDir, 'HEAD'))) throw new RepoToolError('The local clone of this repository is missing.');
    return git(args, { gitDir: this.gitDir, timeoutMs: READ_TIMEOUT_MS, ...options });
  }

  private checkPath(path: string): void {
    if (!isRepoPath(path)) throw new RepoToolError(`Invalid path ${JSON.stringify(String(path).slice(0, 200))}. Use a path relative to the repository root, without ".." or a leading "-".`);
  }

  private async entry(path: string, signal?: AbortSignal): Promise<TreeEntry | undefined> {
    const result = await this.run(['ls-tree', '-z', '-l', this.sha, '--', path], { signal, maxBytes: MAX_LIST_BYTES });
    return parseTree(result.stdout.toString('utf8')).find((e) => e.path === path);
  }

  /** Lists a directory, or with `recursive` everything under it. The root is the empty path. */
  async listDir(path: string, recursive = false, signal?: AbortSignal): Promise<string> {
    const root = path === '' || path === '.' || path === '/';
    const clean = root ? '' : path.replace(/\/+$/, '');
    if (!root) this.checkPath(clean);
    const args = ['ls-tree', '-z', '-l', ...(recursive ? ['-r'] : []), this.sha, ...(root ? [] : ['--', `${clean}/`])];
    const result = await this.run(args, { signal, maxBytes: MAX_LIST_BYTES });
    if (result.timedOut || failed(result)) throw new RepoToolError('Could not list this directory.');
    const entries = parseTree(result.stdout.toString('utf8'));
    if (!entries.length) {
      const self = root ? undefined : await this.entry(clean, signal);
      throw new RepoToolError(self ? `${clean} is a file, not a directory. Use read_file.` : `No directory named ${clean || '/'}.`);
    }
    const sorted = entries.sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.path.localeCompare(b.path));
    const shown = sorted.slice(0, MAX_LISTED_ENTRIES).map((e) => {
      if (e.type === 'tree') return `${e.path}/`;
      if (e.type === 'commit') return `${e.path}  (submodule, not available)`;
      if (e.mode === '120000') return `${e.path}  (symlink)`;
      return `${e.path}  (${e.size} bytes)`;
    });
    const more = entries.length > shown.length || result.cut ? `\n… [listing cut at ${shown.length} entries; list a subdirectory or search instead]` : '';
    return clip(shown.join('\n') + more, MAX_RESULT_CHARS, 'listing shortened; list a subdirectory instead');
  }

  /** Reads part of a file, with each line numbered as `citation` would refer to it. */
  async readFile(path: string, startLine?: number, endLine?: number, signal?: AbortSignal): Promise<string> {
    this.checkPath(path);
    const start = Number.isInteger(startLine) && startLine! > 0 ? startLine! : 1;
    const wanted = Number.isInteger(endLine) && endLine! >= start ? endLine! : start + MAX_READ_LINES - 1;
    const end = Math.min(wanted, start + MAX_READ_LINES - 1);
    const entry = await this.entry(path, signal);
    if (!entry) throw new RepoToolError(`No file named ${path}.`);
    if (entry.type === 'tree') throw new RepoToolError(`${path} is a directory. Use list_dir.`);
    if (entry.type === 'commit') throw new RepoToolError(`${path} is a submodule, and submodules aren't available.`);
    // Reads the blob itself, so a symlink gives back where it points, and never what's there.
    const result = await this.run(['show', `${this.sha}:${path}`], { signal, maxBytes: MAX_FILE_BYTES });
    if (result.timedOut || failed(result)) throw new RepoToolError(`Could not read ${path}.`);
    if (entry.mode === '120000') return `${path} is a symlink to ${JSON.stringify(result.stdout.toString('utf8').slice(0, 500))}, and links are not followed.`;
    if (result.stdout.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return `${path} is a binary file (${entry.size} bytes), so it can't be shown.`;
    const lines = result.stdout.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (result.cut) lines.pop();
    if (start > lines.length) {
      throw new RepoToolError(`${path} ${result.cut ? 'was only read as far as' : 'has'} ${lines.length} lines, so start_line ${start} is past the end.`);
    }
    const last = Math.min(end, lines.length);
    const width = String(last).length;
    let body = '';
    let shownTo = start - 1;
    for (let n = start; n <= last; n++) {
      const line = lines[n - 1];
      const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line shortened]` : line;
      const row = `${String(n).padStart(width)}| ${text}\n`;
      if (body.length + row.length > MAX_RESULT_CHARS) break;
      body += row;
      shownTo = n;
    }
    const total = result.cut ? `more than ${lines.length}` : String(lines.length);
    const header = `${path}: lines ${start}-${shownTo} of ${total}${shownTo < lines.length ? `. Continue with start_line ${shownTo + 1}.` : ''}`;
    return `${header}\n${body}`;
  }

  /** Searches the files at this commit. Plain text and any case, unless `regex` asks otherwise. */
  async search(query: string, opts: { path?: string; regex?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    // eslint-disable-next-line no-control-regex
    if (typeof query !== 'string' || !query || query.length > MAX_QUERY_CHARS || /[\u0000-\u001f]/.test(query)) {
      throw new RepoToolError(`A search needs a query of one line, up to ${MAX_QUERY_CHARS} characters.`);
    }
    const scope = opts.path ? opts.path.replace(/\/+$/, '') : '';
    if (scope) this.checkPath(scope);
    const args = [
      'grep', '-n', '-I', '-i', '-z', '--no-color', '--full-name', opts.regex ? '--extended-regexp' : '--fixed-strings',
      '-e', query, this.sha, '--', ...(scope ? [scope] : []),
    ];
    const result = await this.run(args, { signal: opts.signal, maxBytes: MAX_SEARCH_BYTES });
    if (result.timedOut) throw new RepoToolError('The search took too long. Use a simpler query or a narrower path.');
    if (result.code === 1 && !result.cut) return `No matches for ${JSON.stringify(query)}.`;
    if (failed(result)) throw new RepoToolError(`The search failed: ${result.stderr.trim().slice(0, 200)}`);
    const rows: string[] = [];
    const prefix = `${this.sha}:`;
    let more = result.cut;
    for (const raw of result.stdout.toString('utf8').split('\n')) {
      if (!raw) continue;
      if (rows.length === MAX_SEARCH_LINES) {
        more = true;
        break;
      }
      // With -z, a NUL follows the file name and the line number instead of a colon.
      const [file, ...parts] = raw.split('\0');
      if (!parts.length) continue;
      const rest = parts.join(':');
      const text = rest.length > MAX_SEARCH_LINE_CHARS ? `${rest.slice(0, MAX_SEARCH_LINE_CHARS)}…` : rest;
      rows.push(`${file.startsWith(prefix) ? file.slice(prefix.length) : file}:${text}`);
    }
    const body = clip(rows.join('\n'), MAX_RESULT_CHARS, 'results shortened; narrow the query or the path');
    return more ? `${body}\n… [more matches not shown; narrow the query or the path]` : body;
  }
}
