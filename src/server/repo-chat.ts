import { TOOL_TAG, parseReply, withRepairedTags, withoutImaginedResults, type ToolCall } from '../shared/assistant.js';
import { t } from '../shared/i18n.js';
import type { AgentRequest } from './agents.js';
import type { JobContext } from './jobs.js';
import { repoChatPrompt, type RepoStep } from './prompts.js';
import { MAX_RESULT_CHARS, RepoToolError, type RepoReader } from './repo.js';

/**
 * The reader chat's tool loop. The agent has no real tools, so it writes down what it wants to
 * read, the server reads that from the linked repository at its pinned commit, and the agent
 * starts again with the results. Everything is read-only and scoped, so nothing asks for approval.
 */

/** Calls of the agent for one question, so also how long the reader can be kept waiting. */
export const MAX_REPO_STEPS = 8;
const MAX_CALLS_PER_REPLY = 8;
/** Shared by the results of one reply, which can ask for many long reads at once. */
export const MAX_REPLY_RESULT_CHARS = 60_000;
const MAX_FILES_LISTED = 40;
const MAX_NOTE_CHARS = 80;

type Args = Record<string, unknown>;

/** A request written out with no block around it, which would otherwise read as the answer. */
const BARE_CALL = /\[\s*\{\s*"tool"\s*:[^\n]*\}\s*\]/g;

/**
 * Reads a reply more forgivingly than the assistant does, since every tool here is read-only
 * and scoped. Models often get the block slightly wrong, and that shouldn't pass for an answer.
 */
function readReply(raw: string) {
  const cleaned = withoutImaginedResults(raw);
  const reply = parseReply(withRepairedTags(cleaned));
  const imagined = cleaned !== raw;
  if (reply.calls.length || reply.error) return { ...reply, imagined };
  const bare: ToolCall[] = [];
  for (const [match] of reply.text.matchAll(BARE_CALL)) {
    try {
      for (const item of JSON.parse(match)) if (typeof item?.tool === 'string') bare.push({ tool: item.tool, args: item.args ?? {} });
    } catch {
      /* It only looked like one, so it stays in the text. */
    }
  }
  return { ...reply, imagined, calls: bare, text: reply.text.replace(BARE_CALL, '').trim(), suggestions: bare.length ? [] : reply.suggestions };
}

const clipNote = (text: string) => (text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}…` : text);

/**
 * Runs one tool call. The model only ever chooses among these three and their paths:
 * any `repo` or `url` it adds is ignored, because the reader is already scoped.
 */
export async function runRepoTool(reader: RepoReader, tool: string, args: Args, signal?: AbortSignal): Promise<string> {
  const number = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined);
  const path = args.path;
  switch (tool) {
    case 'list_dir':
      if (path !== undefined && typeof path !== 'string') throw new RepoToolError('path must be a string.');
      return reader.listDir(path ?? '', args.recursive === true, signal);
    case 'read_file':
      if (typeof path !== 'string') throw new RepoToolError('read_file needs a path.');
      return reader.readFile(path, number(args.start_line), number(args.end_line), signal);
    case 'search_code':
      if (path !== undefined && typeof path !== 'string') throw new RepoToolError('path must be a string.');
      return reader.search(args.query as string, { path: path as string | undefined, regex: args.regex === true, signal });
    default:
      throw new RepoToolError(`Unknown tool ${JSON.stringify(tool.slice(0, 60))}. The tools are list_dir, read_file and search_code.`);
  }
}

/** What the reader sees while a call runs. */
function describeCall(tool: string, args: Args): string {
  const path = typeof args.path === 'string' ? args.path : '';
  if (tool === 'read_file') return t('正在读取 {path}', { path: clipNote(path) });
  if (tool === 'search_code') return t('正在搜索 {query}', { query: clipNote(String(args.query ?? '')) });
  if (tool === 'list_dir') return t('正在查看目录 {path}', { path: clipNote(path || '/') });
  return t('正在阅读代码');
}

export interface RepoChatInput {
  meta: Parameters<typeof repoChatPrompt>[0]['meta'];
  text: string;
  truncated: boolean;
  history: Parameters<typeof repoChatPrompt>[0]['history'];
  question: string;
  selection?: string;
  page?: number;
  repo: Parameters<typeof repoChatPrompt>[0]['repo'];
}

export interface RepoChatDeps {
  runAgent(req: AgentRequest): Promise<string>;
  agent: Pick<AgentRequest, 'backend' | 'model' | 'thinking'>;
  reader: RepoReader;
  ctx: JobContext;
}

export interface RepoChatAnswer {
  text: string;
  suggestions: string[];
  filesRead: string[];
}

/** Asks until the agent answers. The last step takes the tools away, so it has to answer with what it has. */
export async function answerWithRepo(input: RepoChatInput, { runAgent, agent, reader, ctx }: RepoChatDeps): Promise<RepoChatAnswer> {
  const steps: RepoStep[] = [];
  const filesRead = new Set<string>();
  // Failing here isn't worth stopping for: the agent can still ask for it and hear what's wrong.
  const rootListing = await reader.listDir('', false, ctx.signal).catch((err: Error) => {
    ctx.signal.throwIfAborted();
    return `The listing failed: ${err.message}`;
  });
  for (let step = 0; step < MAX_REPO_STEPS; step++) {
    const final = step === MAX_REPO_STEPS - 1;
    ctx.progress({ done: step, total: MAX_REPO_STEPS, note: t('{agent} 正在思考', { agent: agent.backend }) });
    const raw = await runAgent({
      ...agent,
      ...repoChatPrompt({ ...input, rootListing, steps, maxSteps: MAX_REPO_STEPS, final }),
      onDelta: ctx.delta,
      signal: ctx.signal,
    });
    ctx.signal.throwIfAborted();
    const { text, calls, error, suggestions, imagined } = readReply(raw);
    if (final || (!calls.length && !error && !imagined)) {
      if (!text) {
        throw new Error(
          final ? t('{agent} 读完代码后没有给出回答。可以再问一次。', { agent: agent.backend }) : t('{agent} 没有返回内容。{detail}', { agent: agent.backend, detail: '' }),
        );
      }
      // An answer that ends on a request nothing will run may still have said something useful.
      return { text, suggestions: calls.length || error || imagined ? [] : suggestions, filesRead: [...filesRead].slice(0, MAX_FILES_LISTED) };
    }
    // The next step starts over, and only its own reply can end up as the answer.
    ctx.reset();
    const results: RepoStep['results'] = [];
    if (error) results.push({ tool: 'unreadable_block', args: {}, status: 'error', result: `${error} Nothing was run. Write the block again as a JSON array.` });
    if (imagined) {
      results.push({
        tool: 'not_a_real_result',
        args: {},
        status: 'error',
        result: `${calls.length ? 'Only the requests inside the block ran.' : 'Nothing was run.'} You wrote tool results yourself. Only the app writes results, after you stop, so anything you wrote isn't real. To read, end your reply with a <${TOOL_TAG}> block and stop there. To answer, write the answer with no block.`,
      });
    }
    let room = MAX_REPLY_RESULT_CHARS;
    for (const call of calls.slice(0, MAX_CALLS_PER_REPLY)) {
      ctx.signal.throwIfAborted();
      ctx.progress({ done: step, total: MAX_REPO_STEPS, note: describeCall(call.tool, call.args) });
      try {
        const result = await runRepoTool(reader, call.tool, call.args, ctx.signal);
        const limit = Math.min(MAX_RESULT_CHARS, room);
        results.push({
          tool: call.tool,
          args: call.args,
          status: 'done',
          result: result.length > limit ? `${result.slice(0, limit)}\n… [shortened: this reply asked for too much at once]` : result,
        });
        room = Math.max(0, room - Math.min(result.length, limit));
        if (call.tool === 'read_file') filesRead.add(call.args.path as string);
      } catch (err) {
        ctx.signal.throwIfAborted();
        results.push({ tool: call.tool, args: call.args, status: 'error', result: err instanceof RepoToolError ? err.message : `The tool failed: ${(err as Error).message}` });
      }
    }
    if (calls.length > MAX_CALLS_PER_REPLY) {
      results.push({ tool: 'too_many_calls', args: {}, status: 'error', result: `Only the first ${MAX_CALLS_PER_REPLY} requests in a block run, so the rest were skipped.` });
    }
    steps.push({ text, results });
  }
  // The final step always returns or throws above.
  throw new Error(t('{agent} 读完代码后没有给出回答。可以再问一次。', { agent: agent.backend }));
}
