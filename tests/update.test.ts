import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localStatus } from '../src/server/update';

describe('comparing with origin/main', () => {
  let dir: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const commit = (cwd: string, name: string) => {
    writeFileSync(join(cwd, name), name);
    git(cwd, 'add', '-A');
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', name);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wenqu-update-'));
    const upstream = join(dir, 'upstream');
    clone = join(dir, 'clone');
    git(dir, 'init', '-q', '-b', 'main', upstream);
    commit(upstream, 'one');
    git(dir, 'clone', '-q', upstream, clone);
    commit(upstream, 'two');
    commit(upstream, 'three');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts only what has been fetched', async () => {
    expect(await localStatus(clone)).toEqual({ behind: 0 });
    git(clone, 'fetch', '-q');
    expect(await localStatus(clone)).toEqual({ behind: 2 });
  });

  it('explains why a checkout can not update', async () => {
    writeFileSync(join(clone, 'dirty'), 'x');
    expect((await localStatus(clone)).blocked).toBeTruthy();
    commit(clone, 'dirty');
    expect((await localStatus(clone)).blocked).toBeTruthy();
    git(clone, 'switch', '-q', '-c', 'work');
    expect((await localStatus(clone)).blocked).toContain('work');
  });
});
