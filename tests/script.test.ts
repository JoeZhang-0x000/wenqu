import { describe, expect, it } from 'vitest';
import { cleanSpeech, parseScript, splitLongText } from '../src/server/script';
import { scriptBudget } from '../src/server/prompts';
import { MAX_ROUND_CHARS, MAX_SCRIPT_CHARS } from '../src/shared/types';

describe('parseScript', () => {
  it('parses title and alternating speakers', () => {
    const { title, rounds } = parseScript('TITLE: 注意力\nA: 你好\nB：今天聊论文\nA: 好');
    expect(title).toBe('注意力');
    expect(rounds).toEqual([
      { speaker: 0, text: '你好' },
      { speaker: 1, text: '今天聊论文' },
      { speaker: 0, text: '好' },
    ]);
  });

  it('tolerates Markdown decoration and code fences', () => {
    const { title, rounds } = parseScript('```\n**TITLE:** Hello\n**A:** first\n**B:** *second*\n```');
    expect(title).toBe('Hello');
    expect(rounds.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('joins wrapped lines into the previous turn', () => {
    expect(parseScript('A: one\ntwo\nB: three').rounds[0].text).toBe('one two');
  });

  it('removes page citations from speech', () => {
    expect(cleanSpeech('结果很好 [p.3] 真的 [p. 4-5]')).toBe('结果很好 真的');
  });

  it('does not mistake ordinary sentences for speakers', () => {
    expect(parseScript('Apple: fruit\nA: real').rounds).toEqual([{ speaker: 0, text: 'real' }]);
  });

  it('splits overlong turns into rounds within the API limit', () => {
    const { rounds } = parseScript(`A: ${'这是一句话。'.repeat(200)}`);
    expect(rounds.length).toBeGreaterThan(1);
    expect(rounds.every((r) => r.speaker === 0 && r.text.length <= MAX_ROUND_CHARS)).toBe(true);
    expect(rounds.map((r) => r.text).join('')).toBe('这是一句话。'.repeat(200));
  });
});

describe('splitLongText', () => {
  it('cuts text with no punctuation at the limit', () => {
    const parts = splitLongText('字'.repeat(700), 300);
    expect(parts.map((p) => p.length)).toEqual([300, 300, 100]);
  });

  it('prefers sentence boundaries', () => {
    expect(splitLongText(`${'a'.repeat(200)}. ${'b'.repeat(200)}`, 300)[0]).toBe(`${'a'.repeat(200)}.`);
  });
});

describe('scriptBudget', () => {
  it('stays under the API limit for long English episodes', () => {
    expect(scriptBudget('en', 'long')).toBeLessThan(MAX_SCRIPT_CHARS);
  });

  it('scales with length', () => {
    expect(scriptBudget('zh', 'short')).toBeLessThan(scriptBudget('zh', 'long'));
  });
});
