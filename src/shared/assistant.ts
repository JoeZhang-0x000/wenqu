/** Agents have no real tools, so they ask for actions by writing this block in their reply. */
export const TOOL_TAG = 'wenqu_tools';

/** Models sometimes fall back on the tag they know best, so those count too. */
const TAGS = [TOOL_TAG, 'function_calls', 'tool_calls'];
const OPENINGS = TAGS.map((tag) => `<${tag}>`);

/** The first block at or after `from`. `end` is -1 if it was never closed. */
function nextBlock(text: string, from: number) {
  let found: { start: number; tag: string } | undefined;
  for (const tag of TAGS) {
    const start = text.indexOf(`<${tag}>`, from);
    if (start >= 0 && (!found || start < found.start)) found = { start, tag };
  }
  if (!found) return undefined;
  const close = `</${found.tag}>`;
  const bodyStart = found.start + found.tag.length + 2;
  const end = text.indexOf(close, bodyStart);
  return { start: found.start, bodyStart, end, after: end < 0 ? text.length : end + close.length };
}

/** The owner recorded on the assistant's background jobs, which belong to no paper. */
export const ASSISTANT_OWNER = 'assistant';

/** A reply without its action blocks, including a block still being written while it streams. */
export function visibleReply(raw: string): string {
  let text = '';
  let position = 0;
  for (;;) {
    const block = nextBlock(raw, position);
    if (!block) break;
    text += raw.slice(position, block.start);
    position = block.after;
  }
  text += raw.slice(position);
  // The stream may have stopped partway through an opening tag.
  const partial = OPENINGS.flatMap((open) => Array.from({ length: open.length - 1 }, (_, n) => open.slice(0, n + 1)))
    .filter((prefix) => text.endsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  if (partial) text = text.slice(0, -partial.length);
  // Some models put the block in a code fence, which would otherwise be left empty.
  return text.replace(/```[\w-]*\s*```/g, '').trim();
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
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseReply(raw: string): ParsedReply {
  const text = visibleReply(raw);
  const calls: ToolCall[] = [];
  let error: string | undefined;
  let position = 0;
  for (;;) {
    const block = nextBlock(raw, position);
    if (!block) break;
    position = block.after;
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
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!isRecord(item) || typeof item.tool !== 'string') throw new Error('each entry needs a "tool" name');
        calls.push({ tool: item.tool, args: isRecord(item.args) ? item.args : {} });
      }
    } catch (err) {
      error = `The action block is not valid: ${(err as Error).message}`;
    }
  }
  return { text, calls, error };
}
