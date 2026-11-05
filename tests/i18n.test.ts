import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dictionary, getLocale, setLocale, t, tx } from '../src/shared/i18n';
import { BLOG_STYLES, COLLECTION_MODES, PODCAST_LENGTHS, PODCAST_STYLES, SPEAKER_PAIRS } from '../src/shared/types';

const CJK = /[㐀-鿿]/;

/** Lines that hold Chinese on purpose, and are never shown as interface text. */
const ALLOWED: Record<string, RegExp[]> = {
  'figures.ts': [/const CAPTION =/, /u3400|㐀/],
  'pdf.ts': [/test\(|abstract/i],
  // Patterns for reading Chinese papers.
  'repo-detect.ts': [/开源|基于|参考文献|㐀/],
  'script.ts': [/const (SPEAKER|TITLE)_LINE =/],
  // Spoken by a Chinese voice during the connection test.
  'server.ts': [/nlp_texts/],
  // Help text exists in both languages.
  'cli.ts': [/^/],
  'Settings.tsx': [/label: '中文'/],
  // The verse is the same in every language.
  'Library.tsx': [/const VERSE =/],
};

describe('translations', () => {
  afterEach(() => setLocale('en'));

  it('translates and fills in parameters', () => {
    setLocale('en');
    expect(t('已导入：{title}', { title: 'X' })).toBe('Imported: X');
    setLocale('zh');
    expect(getLocale()).toBe('zh');
    expect(t('已导入：{title}', { title: 'X' })).toBe('已导入：X');
  });

  it('passes unknown data through', () => {
    expect(tx('日本語')).toBe('日本語');
    expect(tx('轻松对谈')).toBe('Casual chat');
  });

  it('keeps the same placeholders in both languages', () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(dictionary)) expect(names(value), key).toEqual(names(key));
  });

  it('has no Chinese left in the English text', () => {
    for (const [key, value] of Object.entries(dictionary)) expect(CJK.test(value), key).toBe(false);
  });

  it('covers every preset', () => {
    const labels = [...PODCAST_STYLES, ...BLOG_STYLES, ...PODCAST_LENGTHS, ...COLLECTION_MODES, ...SPEAKER_PAIRS].flatMap((o: any) => [o.label, o.hint]);
    for (const label of labels.filter(Boolean)) expect(tx(label), label).not.toMatch(CJK);
  });

  it('leaves no hard-coded Chinese outside t()', () => {
    const found: string[] = [];
    for (const dir of ['web/src', 'src/server']) {
      for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
        const allowed = ALLOWED[file] ?? [];
        readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.replace(/\bt\(\s*'(?:[^'\\]|\\.)*'/g, '').replace(/\/\/.*$/, '');
            if (CJK.test(code) && !allowed.some((re) => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
