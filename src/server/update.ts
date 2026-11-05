import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';
import type { UpdateStatus } from '../shared/types.js';

const FETCH_TTL_MS = 6 * 60 * 60_000;

function run(cwd: string, command: string, args: string[], timeout = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // npm is a .cmd file on Windows, which only starts through a shell.
    execFile(command, args, { cwd, timeout, env, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim().slice(-2000) || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** The checkout this server runs from. There is none when it was installed some other way. */
async function checkoutRoot(): Promise<string | undefined> {
  try {
    const root = await run(dirname(fileURLToPath(import.meta.url)), 'git', ['rev-parse', '--show-toplevel']);
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'wenqu' ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Compares with what was last fetched from origin/main. Nothing here touches the network. */
export async function localStatus(root: string): Promise<UpdateStatus> {
  const git = (...args: string[]) => run(root, 'git', args);
  const count = async (range: string) => Number(await git('rev-list', '--count', range));
  const behind = await count('HEAD..origin/main');
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') return { behind, blocked: t('当前在 {branch} 分支，只有 main 分支能自动更新', { branch }) };
  if (await git('status', '--porcelain')) return { behind, blocked: t('本地有未提交的改动，无法自动更新') };
  if (await count('origin/main..HEAD')) return { behind, blocked: t('本地有未推送的提交，无法自动更新') };
  return { behind };
}

let lastFetch = 0;

export async function updateStatus(): Promise<UpdateStatus> {
  const root = await checkoutRoot();
  if (!root) return { behind: 0 };
  if (Date.now() - lastFetch > FETCH_TTL_MS) {
    lastFetch = Date.now();
    // Being offline just means comparing with the last fetch.
    await run(root, 'git', ['fetch', '--quiet', 'origin', 'main'], 60_000).catch(() => {});
  }
  return localStatus(root).catch(() => ({ behind: 0 }));
}

export async function applyUpdate(): Promise<void> {
  const root = await checkoutRoot();
  if (!root) throw new Error(t('当前不是 git 安装，无法自动更新'));
  await run(root, 'git', ['pull', '--ff-only', '--quiet', 'origin', 'main']);
  await run(root, 'npm', ['install', '--no-audit', '--no-fund']);
  await run(root, 'npm', ['run', 'build']);
}

/**
 * Starts the new build on the same port. This process stays behind only to pass on signals and
 * the exit code, so the server stays in the foreground of its terminal and Ctrl+C still stops it.
 */
export function restartServer(server: Server, port: number): void {
  server.close();
  server.closeAllConnections();
  const child = spawn(process.execPath, [...process.argv.slice(1), '--no-open', '--port', String(port)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}
