import type { AssistantMessage } from './types.js';

/** Agents have no real tools, so they ask for actions by writing this block in their reply. */
export const TOOL_TAG = 'wenqu_tools';

/** Agents end a reply with this block to offer what the user might send next. It's never shown as text. */
export const SUGGESTION_TAG = 'wenqu_suggestions';

/** Models sometimes fall back on the tag they know best, so those count too. */
const ASSISTANT_TAGS = [TOOL_TAG, 'function_calls', 'tool_calls', SUGGESTION_TAG];
/**
 * The reader chat has no tools, and an answer about a paper may well mention <tool_calls>,
 * so there only the suggestions are hidden.
 */
const ANSWER_TAGS = [SUGGESTION_TAG];

/** The first block at or after `from`. `end` is -1 if it was never closed. */
function nextBlock(text: string, from: number, tags: string[]) {
  let found: { start: number; tag: string } | undefined;
  for (const tag of tags) {
    const start = text.indexOf(`<${tag}>`, from);
    if (start >= 0 && (!found || start < found.start)) found = { start, tag };
  }
  if (!found) return undefined;
  const close = `</${found.tag}>`;
  const bodyStart = found.start + found.tag.length + 2;
  const end = text.indexOf(close, bodyStart);
  return { start: found.start, tag: found.tag, bodyStart, end, after: end < 0 ? text.length : end + close.length };
}

/** The owner recorded on the assistant's background jobs, which belong to no paper. */
export const ASSISTANT_OWNER = 'assistant';

/** Everything that hides blocks goes through here, so a stream and the stored reply always agree. */
function withoutBlocks(raw: string, tags: string[]): string {
  let text = '';
  let position = 0;
  for (;;) {
    const block = nextBlock(raw, position, tags);
    if (!block) break;
    let before = raw.slice(position, block.start);
    let after = block.after;
    // Some models put the block in a code fence, which would otherwise be left empty.
    const opening = /```[\w-]*\s*$/.exec(before);
    const closing = /^\s*```/.exec(raw.slice(after));
    if (opening && (closing || block.end < 0)) {
      before = before.slice(0, opening.index);
      after += closing?.[0].length ?? 0;
    }
    text += before;
    position = after;
  }
  text += raw.slice(position);
  // The stream may have stopped partway through an opening tag.
  const partial = tags
    .flatMap((tag) => Array.from({ length: tag.length + 1 }, (_, n) => `<${tag}`.slice(0, n + 1)))
    .filter((prefix) => text.endsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  if (partial) text = text.slice(0, -partial.length);
  return text.trim();
}

/** An assistant reply without its blocks, including a block still being written while it streams. */
export function visibleReply(raw: string): string {
  return withoutBlocks(raw, ASSISTANT_TAGS);
}

/** The same for the reader chat, whose answers can't ask for actions. */
export function visibleAnswer(raw: string): string {
  return withoutBlocks(raw, ANSWER_TAGS);
}

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 60;

/** Control and invisible characters, including the ones that reorder text. */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function plainSuggestion(item: string): string | undefined {
  const text = item
    .replace(INVISIBLE, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:[-*+#>]+|\d+[.)])\s+/, '')
    .trim();
  // A click sends this as the user's own words, so it can't be allowed to carry conversation structure.
  // Too long means dropped rather than cut, because a cut sentence is a poor message to send.
  if (!text || /<[a-z/!?]/i.test(text) || [...text].length > MAX_SUGGESTION_CHARS) return undefined;
  return text;
}

/** Whatever a model wrote, this is at most a few short, distinct lines of plain text. */
export function sanitizeSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? plainSuggestion(item) : undefined;
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    items.push(text);
    if (items.length === MAX_SUGGESTIONS) break;
  }
  return items;
}

/**
 * Only a closed block that ends the reply counts, so a block merely quoted in the middle of
 * an answer offers nothing. Anything unreadable means no suggestions, never an error.
 */
export function parseSuggestions(raw: string): string[] {
  const open = `<${SUGGESTION_TAG}>`;
  const close = `</${SUGGESTION_TAG}>`;
  const start = raw.lastIndexOf(open);
  if (start < 0) return [];
  const end = raw.indexOf(close, start + open.length);
  if (end < 0 || !/^\s*(?:```\s*)?$/.test(raw.slice(end + close.length))) return [];
  const body = raw
    .slice(start + open.length, end)
    .trim()
    .replace(/^```[\w-]*\s*|\s*```$/g, '');
  try {
    return sanitizeSuggestions(JSON.parse(body));
  } catch {
    return [];
  }
}

/** A reader chat reply, split into what to store and what to offer next. */
export function parseAnswer(raw: string): { text: string; suggestions: string[] } {
  return { text: visibleAnswer(raw), suggestions: parseSuggestions(raw) };
}

/** What to offer right now. Only a settled conversation's latest reply has anything to offer. */
export function latestSuggestions(messages: Pick<AssistantMessage, 'role' | 'error' | 'actions' | 'suggestions'>[], busy = false): string[] {
  if (busy || messages.some((m) => m.actions?.some((a) => a.status === 'pending'))) return [];
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || last.error || last.actions?.length) return [];
  return last.suggestions ?? [];
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ParsedReply {
  text: string;
  calls: ToolCall[];
  /** Why a block couldn't be read, so the agent can be told and try again. */
  error?: string;
  /** Empty when the reply asks for anything, because then it isn't the end of the turn. */
  suggestions: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseReply(raw: string): ParsedReply {
  const text = visibleReply(raw);
  const calls: ToolCall[] = [];
  let error: string | undefined;
  let position = 0;
  for (;;) {
    const block = nextBlock(raw, position, ASSISTANT_TAGS);
    if (!block) break;
    position = block.after;
    if (block.tag === SUGGESTION_TAG) continue;
    if (block.end < 0) {
      error = 'The action block was never closed.';
      break;
    }
    const body = raw
      .slice(block.bodyStart, block.end)
      .trim()
      .replace(/^```[\w-]*\s*|\s*```$/g, '');
    try {
      const parsed: unknown = JSON.parse(body);
      // All or nothing, because the agent is told a block it can't read wasn't run.
      const entries = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => {
        if (!isRecord(item) || typeof item.tool !== 'string') throw new Error('each entry needs a "tool" name');
        return { tool: item.tool, args: isRecord(item.args) ? item.args : {} };
      });
      calls.push(...entries);
    } catch (err) {
      error = `The action block is not valid: ${(err as Error).message}`;
    }
  }
  return { text, calls, error, suggestions: calls.length || error ? [] : parseSuggestions(raw) };
}
