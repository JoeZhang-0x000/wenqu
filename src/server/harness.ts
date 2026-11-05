import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentCommand } from './agents.js';
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

const named = (id: string, efforts: string[]): AgentModel => ({ id, label: id, efforts });

const list = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Reads `--effort <level> ... (low, medium, high)` from the Claude Code help text. */
export function parseClaudeEfforts(help: string): string[] {
  return list(help.replace(/\s+/g, ' ').match(/--effort <level>[^(]*\(([^)]*)\)/)?.[1] ?? '');
}

/** Reads `--thinking <level>  Set thinking level: off, low, high` from the pi help text. */
export function parsePiEfforts(help: string): string[] {
  return list(help.match(/--thinking <level>[^:\n]*:([^\n]*)/)?.[1] ?? '');
}

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
    .map(
      (m: any): AgentModel => ({
        id: m.slug,
        label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((level: any) => level.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level,
      }),
    );
}

/** `pi --list-models` prints a table: provider, model, context, max-out, thinking, images. */
export function parsePiModels(table: string, efforts: string[]): AgentModel[] {
  return table
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2)
    .map((cols) => named(`${cols[0]}/${cols[1]}`, cols[4] === 'yes' ? efforts : []));
}

/** dsh has no list command. It prints its configuration, which names the default model. */
export function parseDshDefaultModel(config: string): string | undefined {
  return config.match(/id: agent-default-model\n[\s\S]*?\n\s+model: (\S+)/)?.[1];
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
  efforts: string[];
  defaultEffort?: string;
}

const CATALOGS: Record<AgentBackend, () => Promise<Catalog>> = {
  async claude() {
    const settings = readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'));
    const { out } = await capture('claude', ['--help'], 15_000);
    const defaultModel: string | undefined = process.env.ANTHROPIC_MODEL || settings.model;
    const ids = new Set<string>([...parseClaudeModels(out), ...(settings.availableModels ?? [])]);
    if (defaultModel) ids.add(defaultModel);
    const efforts = parseClaudeEfforts(out);
    return { models: [...ids].map((id) => named(id, efforts)), defaultModel, efforts, defaultEffort: settings.effortLevel };
  },
  async codex() {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    const config = read(join(home, 'config.toml')) ?? '';
    const defaultModel = readTomlString(config, 'model');
    const { ok, out } = await capture('codex', ['debug', 'models'], 20_000);
    let models: AgentModel[] = [];
    if (ok) {
      try {
        models = parseCodexModels(out);
      } catch {
        /* An unexpected format just means no list. */
      }
    }
    const fallback = models.find((m) => m.id === defaultModel) ?? models[0];
    return {
      models,
      defaultModel,
      efforts: fallback?.efforts ?? [],
      defaultEffort: readTomlString(config, 'model_reasoning_effort') ?? fallback?.defaultEffort,
    };
  },
  async pi() {
    const settings = readJson(join(homedir(), '.pi', 'agent', 'settings.json'));
    const [{ ok, out }, help] = await Promise.all([capture('pi', ['--list-models'], 20_000), capture('pi', ['--help'], 15_000)]);
    const efforts = parsePiEfforts(help.out);
    const defaultModel = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined;
    return { models: ok ? parsePiModels(out, efforts) : [], defaultModel, efforts, defaultEffort: settings.defaultThinkingLevel };
  },
  async dsh() {
    const { out } = await capture(agentCommand('dsh'), ['--profile', 'headless', '--dump-config'], 15_000);
    const efforts = ['off', 'high', 'max'];
    return { models: ['deepseek-v4-flash', 'deepseek-v4-pro'].map((id) => named(id, efforts)), defaultModel: parseDshDefaultModel(out), efforts };
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
          const { ok, out } = await capture(agentCommand(backend), ['--version'], 8000);
          if (!ok) return { backend, installed: false, models: [], efforts: [] };
          const version = out.trim().split('\n')[0] || undefined;
          const catalog = await CATALOGS[backend]().catch((): Catalog => ({ models: [], efforts: [] }));
          return { backend, installed: true, version, ...catalog };
        }),
      ),
    };
  }
  return detected.agents;
}
