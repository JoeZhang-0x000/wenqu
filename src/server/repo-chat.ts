import { RepoToolError, type RepoReader } from './repo.js';

/**
 * The tools a chat beside a paper uses to read its linked repository. Everything is read-only and
 * scoped to one clone at its pinned commit, so nothing here asks for approval.
 */

type Args = Record<string, unknown>;

/** Line numbers sometimes arrive as strings. */
export const lineArg = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined);

/**
 * Runs one tool call. The model only ever chooses among these three and their paths:
 * any `repo` or `url` it adds is ignored, because the reader is already scoped.
 */
export async function runRepoTool(reader: RepoReader, tool: string, args: Args, signal?: AbortSignal): Promise<string> {
  const path = args.path;
  switch (tool) {
    case 'list_dir':
      if (path !== undefined && typeof path !== 'string') throw new RepoToolError('path must be a string.');
      return reader.listDir(path ?? '', args.recursive === true, signal);
    case 'read_file':
      if (typeof path !== 'string') throw new RepoToolError('read_file needs a path.');
      return reader.readFile(path, lineArg(args.start_line), lineArg(args.end_line), signal);
    case 'search_code':
      if (path !== undefined && typeof path !== 'string') throw new RepoToolError('path must be a string.');
      return reader.search(args.query as string, { path: path as string | undefined, regex: args.regex === true, signal });
    default:
      throw new RepoToolError(`Unknown tool ${JSON.stringify(tool.slice(0, 60))}. The tools are list_dir, read_file and search_code.`);
  }
}
