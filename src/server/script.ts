import { MAX_ROUND_CHARS, type ScriptRound } from '../shared/types.js';

const SPEAKER_LINE = /^\s*(?:[*_#>\s-]*)(?:\[)?(?:host\s*|speaker\s*|主持人\s*)?([ABab])(?:\])?(?:[*_\s]*)[:：](?:[*_\s]*)(.*)$/;
const TITLE_LINE = /^\s*(?:[*_#\s]*)(?:TITLE|标题)(?:[*_\s]*)[:：](?:[*_\s]*)(.+?)[*_\s]*$/i;

/** Removes anything a voice would read aloud by mistake. */
export function cleanSpeech(text: string): string {
  return text
    .replace(/\[p\.?\s*\d+(?:\s*[-–,，]\s*\d+)*\]/gi, '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a long turn at sentence boundaries, falling back to clauses and then to a hard cut. */
export function splitLongText(text: string, limit = MAX_ROUND_CHARS): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    const boundary = (pattern: RegExp) => {
      let last = -1;
      for (const m of head.matchAll(pattern)) last = m.index + m[0].length;
      return last;
    };
    let cut = boundary(/[。！？!?；;]+["”’）)]*|\.\s/g);
    if (cut < limit * 0.4) cut = Math.max(cut, boundary(/[，,、：:]\s*|\s/g));
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface ParsedScript {
  title?: string;
  rounds: ScriptRound[];
}

/** Parses the `TITLE:` / `A:` / `B:` line format used by the script prompt. */
export function parseScript(raw: string): ParsedScript {
  const turns: { speaker: 0 | 1; text: string }[] = [];
  let title: string | undefined;
  for (const line of raw.replace(/^```\w*$/gm, '').split('\n')) {
    const titleMatch = !title && !turns.length ? line.match(TITLE_LINE) : null;
    if (titleMatch) {
      title = cleanSpeech(titleMatch[1]);
      continue;
    }
    const speakerMatch = line.match(SPEAKER_LINE);
    if (speakerMatch) {
      turns.push({ speaker: speakerMatch[1].toUpperCase() === 'A' ? 0 : 1, text: speakerMatch[2] });
    } else if (turns.length && line.trim()) {
      turns[turns.length - 1].text += ` ${line.trim()}`;
    }
  }
  const rounds: ScriptRound[] = [];
  for (const turn of turns) {
    const text = cleanSpeech(turn.text);
    if (text) for (const part of splitLongText(text)) rounds.push({ speaker: turn.speaker, text: part });
  }
  return { title, rounds };
}
