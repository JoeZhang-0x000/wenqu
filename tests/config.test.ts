import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../src/server/config';

describe('settings from the earlier project name', () => {
  const saved = { home: process.env.HOME, dir: process.env.WENQU_CONFIG_DIR, key: process.env.DOUBAO_API_KEY };
  let home: string;

  const writeLegacy = (config: object) => {
    const dir = join(home, '.config', 'paper2podcast');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wenqu-home-'));
    process.env.HOME = home;
    delete process.env.WENQU_CONFIG_DIR;
    delete process.env.DOUBAO_API_KEY;
  });

  afterEach(() => {
    process.env.HOME = saved.home;
    if (saved.dir !== undefined) process.env.WENQU_CONFIG_DIR = saved.dir;
    if (saved.key !== undefined) process.env.DOUBAO_API_KEY = saved.key;
    rmSync(home, { recursive: true, force: true });
  });

  it('starts fresh under the new name when there is nothing to carry over', () => {
    const config = new Config();
    expect(config.get().vaultPath).toBe(join(home, 'Wenqu'));
    expect(existsSync(join(home, '.config', 'wenqu'))).toBe(false);
  });

  it('carries over saved settings privately, and leaves the old file alone', () => {
    writeLegacy({ vaultPath: '/somewhere/vault', doubao: { apiKey: 'secret' } });
    const config = new Config();
    const adopted = join(home, '.config', 'wenqu', 'config.json');
    expect(config.get().vaultPath).toBe('/somewhere/vault');
    expect(config.apiKey()).toBe('secret');
    expect(statSync(adopted).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, '.config', 'paper2podcast', 'config.json'))).toBe(true);
  });

  it('prefers settings already saved under the new name', () => {
    writeLegacy({ vaultPath: '/old' });
    new Config().update({ vaultPath: '/new' });
    writeLegacy({ vaultPath: '/older-still' });
    expect(new Config().get().vaultPath).toBe('/new');
    expect(JSON.parse(readFileSync(join(home, '.config', 'wenqu', 'config.json'), 'utf8')).vaultPath).toBe('/new');
  });

  it('keeps using a vault in the old default location', () => {
    mkdirSync(join(home, 'Paper2Podcast'));
    expect(new Config().get().vaultPath).toBe(join(home, 'Paper2Podcast'));
    mkdirSync(join(home, 'Wenqu'));
    expect(new Config().get().vaultPath).toBe(join(home, 'Wenqu'));
  });
});
