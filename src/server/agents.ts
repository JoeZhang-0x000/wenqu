import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t } from '../shared/i18n.js';
import type { AgentBackend } from '../shared/types.js';

export interface AgentRequest {
  backend: AgentBackend;
  model?: string;
  /** Thinking level. Each CLI has its own flag for it. */
  thinking?: string;
  system: string;
  prompt: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

interface Adapter {
  /** Command-line arguments. The prompt always goes through stdin. */
  args(req: AgentRequest): string[];
  stdin(req: AgentRequest): string;
  /** Handles one JSON line and returns visible text, or throws on a fatal agent error. */
  parse(event: any, state: { final?: string }): string | undefined;
}

/**
 * Paper text is untrusted input and may contain prompt injection, so each backend runs
 * with its tools off (or, for codex, which has no such switch, a read-only sandbox) in an
 * empty working directory. Answers come from the prompt, not from the filesystem.
 */
const ADAPTERS: Record<AgentBackend, Adapter> = {
  claude: {
    args: (r) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt', r.system,
      ...(r.model ? ['--model', r.model] : []),
      ...(r.thinking ? ['--effort', r.thinking] : []),
    ],
    stdin: (r) => r.prompt,
    parse(e, state) {
      if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta') return e.event.delta.text;
      if (e.type === 'result') {
        if (e.is_error) throw new Error(e.result || e.subtype || t('{agent} 返回错误', { agent: 'Claude' }));
        state.final = e.result;
      }
      return undefined;
    },
  },
  pi: {
    args: (r) => [
      '-p',
      '--mode', 'json',
      '--no-tools',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-mcp',
      '--no-context-files',
      '--no-prompt-templates',
      '--system-prompt', r.system,
      ...(r.model ? ['--model', r.model] : []),
      ...(r.thinking ? ['--thinking', r.thinking] : []),
    ],
    stdin: (r) => r.prompt,
    parse(e) {
      if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') return e.assistantMessageEvent.delta;
      if (e.type === 'message_end' && e.message?.role === 'assistant' && e.message.stopReason === 'error') {
        throw new Error(e.message.errorMessage || t('{agent} 返回错误', { agent: 'pi' }));
      }
      return undefined;
    },
  },
  codex: {
    args: (r) => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      ...(r.model ? ['-m', r.model] : []),
      ...(r.thinking ? ['-c', `model_reasoning_effort="${r.thinking}"`] : []),
      '-',
    ],
    // `codex exec` has no system prompt flag.
    stdin: (r) => `${r.system}\n\n---\n\n${r.prompt}`,
    parse(e) {
      // Codex reports config warnings as `error` *items*; only top-level events are fatal.
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') return e.item.text;
      if (e.type === 'turn.failed') throw new Error(e.error?.message || t('{agent} 返回错误', { agent: 'Codex' }));
      if (e.type === 'error') throw new Error(e.message || t('{agent} 返回错误', { agent: 'Codex' }));
      return undefined;
    },
  },
};

const SAFE_MODEL = /^[\w.:@/][\w.:@/-]*$/;

export function runAgent(req: AgentRequest): Promise<string> {
  const adapter = ADAPTERS[req.backend];
  if (!adapter) return Promise.reject(new Error(t('未知的 Agent 后端：{backend}', { backend: req.backend })));
  // A value starting with "-" would be read as a command-line flag.
  if (req.model && !SAFE_MODEL.test(req.model)) return Promise.reject(new Error(t('模型名称无效：{model}', { model: req.model })));

  if (req.thinking && !/^[a-z]+$/.test(req.thinking)) return Promise.reject(new Error(t('思考强度无效：{level}', { level: req.thinking })));

  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'p2p-agent-'));
    const child = spawn(req.backend, adapter.args(req), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    let stderr = '';
    let buffer = '';
    let fatal: Error | undefined;
    const state: { final?: string } = {};

    const onAbort = () => child.kill('SIGTERM');
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const delta = adapter.parse(event, state);
        if (delta) {
          const piece = req.backend === 'codex' && text ? `\n\n${delta}` : delta;
          text += piece;
          req.onDelta?.(piece);
        }
      } catch (err) {
        fatal = err as Error;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    // A CLI that exits early closes stdin under us; the exit code reports the real failure.
    child.stdin.on('error', () => {});
    child.stdin.end(adapter.stdin(req));

    const cleanup = () => {
      req.signal?.removeEventListener('abort', onAbort);
      rmSync(cwd, { recursive: true, force: true });
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new Error(t('找不到命令 {command}，请先安装或在设置中更换后端。', { command: req.backend })) : err);
    });
    child.on('close', (code) => {
      handleLine(buffer);
      cleanup();
      if (req.signal?.aborted) return reject(new Error(t('已取消')));
      if (fatal) return reject(fatal);
      const output = text || state.final || '';
      if (code !== 0 && !output) return reject(new Error(t('{agent} 退出码 {code}：{detail}', { agent: req.backend, code: String(code), detail: stderr.trim() || t('无错误输出') })));
      if (!output.trim()) return reject(new Error(t('{agent} 没有返回内容。{detail}', { agent: req.backend, detail: stderr.trim() })));
      resolve(output);
    });
  });
}
