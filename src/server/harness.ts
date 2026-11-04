import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_BACKENDS, type AgentBackend, type AgentModel, type AgentStatus } from '../shared/types.js';

function capture(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.on('error', () => resolve({ ok: false, out: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const readJson = (path: string): any => {
  const text = read(path);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

const named = (id: string): AgentModel => ({ id, label: id });

/** Claude Code has no list command. Its help names the current aliases, such as 'opus'. */
export function parseClaudeModels(help: string): string[] {
  const text = help.replace(/\s+/g, ' ');
  const aliases = text.match(/--model <model>.*?alias[^(]*\(e\.g\. ([^)]*)\)/)?.[1] ?? '';
  return [...aliases.matchAll(/'([\w.-]+)'/g)].map((m) => m[1]);
}

export function parseCodexModels(json: string): AgentModel[] {
  const models = JSON.parse(json).models ?? [];
  return models
    .filter((m: any) => m.slug && m.visibility !== 'hide')
    .map((m: any): AgentModel => ({ id: m.slug, label: m.display_name || m.slug }));
}

/** `pi --list-models` prints a table whose first two columns are the provider and the model. */
export function parsePiModels(table: string): AgentModel[] {
  return table
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2)
    .map(([provider, model]) => named(`${provider}/${model}`));
}

/** The first top-level `key = "value"` in a TOML file, ignoring anything under a [section]. */
export function readTomlString(toml: string, key: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0];
  return top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
}

interface Catalog {
  models: AgentModel[];
  /** The model the CLI uses when none is given, as far as its config says. */
  defaultModel?: string;
}

const CATALOGS: Record<AgentBackend, () => Promise<Catalog>> = {
  async claude() {
    const settings = readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'));
    const { out } = await capture('claude', ['--help'], 15_000);
    const defaultModel: string | undefined = process.env.ANTHROPIC_MODEL || settings.model;
    const ids = new Set<string>([...parseClaudeModels(out), ...(settings.availableModels ?? [])]);
    if (defaultModel) ids.add(defaultModel);
    return { models: [...ids].map(named), defaultModel };
  },
  async codex() {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    const defaultModel = readTomlString(read(join(home, 'config.toml')) ?? '', 'model');
    const { ok, out } = await capture('codex', ['debug', 'models'], 20_000);
    let models: AgentModel[] = [];
    if (ok) {
      try {
        models = parseCodexModels(out);
      } catch {
        /* An unexpected format just means no list. */
      }
    }
    return { models, defaultModel };
  },
  async pi() {
    const settings = readJson(join(homedir(), '.pi', 'agent', 'settings.json'));
    const { ok, out } = await capture('pi', ['--list-models'], 20_000);
    const defaultModel = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined;
    return { models: ok ? parsePiModels(out) : [], defaultModel };
  },
};

const DETECT_TTL_MS = 5 * 60_000;
let detected: { at: number; agents: Promise<AgentStatus[]> } | undefined;

/** Which agent CLIs are on this machine, and the models each one reports. Starting them is slow, so the answer is kept for a while. */
export function detectAgents(refresh = false): Promise<AgentStatus[]> {
  if (!detected || refresh || Date.now() - detected.at > DETECT_TTL_MS) {
    detected = {
      at: Date.now(),
      agents: Promise.all(
        AGENT_BACKENDS.map(async (backend): Promise<AgentStatus> => {
          const { ok, out } = await capture(backend, ['--version'], 8000);
          if (!ok) return { backend, installed: false, models: [] };
          const version = out.trim().split('\n')[0] || undefined;
          const catalog = await CATALOGS[backend]().catch((): Catalog => ({ models: [] }));
          return { backend, installed: true, version, ...catalog };
        }),
      ),
    };
  }
  return detected.agents;
}
