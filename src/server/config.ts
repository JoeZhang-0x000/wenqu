import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_BACKENDS, SPEAKER_PAIRS, type AgentBackend, type PublicSettings, type Settings, type SettingsPatch } from '../shared/types.js';
import { getLocale, t } from '../shared/i18n.js';
import { DOUBAO_RESOURCE_ID } from './doubao.js';

const configDir = () => process.env.P2P_CONFIG_DIR || join(homedir(), '.config', 'paper2podcast');
const configFile = () => join(configDir(), 'config.json');

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

export function defaultSettings(): Settings {
  return {
    vaultPath: join(homedir(), 'Paper2Podcast'),
    uiLanguage: 'auto',
    agent: { backend: 'claude', models: { pi: '', claude: '', codex: '' }, thinking: { pi: '', claude: '', codex: '' } },
    podcast: {
      language: getLocale(),
      style: 'conversational',
      customStyle: '',
      length: 'medium',
      engine: 'agent',
      speakers: SPEAKER_PAIRS[0].speakers,
      speechRate: 0,
      headMusic: true,
      tailMusic: false,
    },
    blog: { language: getLocale(), style: 'explainer', customStyle: '' },
    doubao: { apiKey: '', resourceId: DOUBAO_RESOURCE_ID },
  };
}

function merge(base: Settings, patch: SettingsPatch): Settings {
  return {
    vaultPath: patch.vaultPath ?? base.vaultPath,
    uiLanguage: patch.uiLanguage ?? base.uiLanguage,
    agent: {
      ...base.agent,
      ...patch.agent,
      models: { ...base.agent.models, ...patch.agent?.models },
      thinking: { ...base.agent.thinking, ...patch.agent?.thinking },
    },
    podcast: { ...base.podcast, ...patch.podcast },
    blog: { ...base.blog, ...patch.blog },
    doubao: { ...base.doubao, ...patch.doubao },
  };
}

/** Holds settings in memory. The API key lives here rather than in the vault, which users may sync or share. */
export class Config {
  private settings: Settings;
  /** `--vault` applies to this run only and is not written back. */
  private vaultOverride?: string;

  constructor(vaultOverride?: string) {
    let saved: SettingsPatch = {};
    if (existsSync(configFile())) {
      try {
        saved = JSON.parse(readFileSync(configFile(), 'utf8'));
      } catch (err) {
        throw new Error(t('无法读取配置文件 {file}：{error}', { file: configFile(), error: (err as Error).message }));
      }
    }
    this.settings = merge(defaultSettings(), saved);
    this.vaultOverride = vaultOverride ? resolve(expandHome(vaultOverride)) : undefined;
  }

  get(): Settings {
    return {
      ...this.settings,
      vaultPath: this.vaultOverride ?? resolve(expandHome(this.settings.vaultPath)),
    };
  }

  /** The effective API key. An environment variable wins over the saved value. */
  apiKey(): string {
    return process.env.DOUBAO_API_KEY || this.settings.doubao.apiKey;
  }

  public(): PublicSettings {
    const s = this.get();
    const key = this.apiKey();
    return {
      ...s,
      doubao: {
        hasKey: Boolean(key),
        keyPreview: key ? `••••${key.slice(-4)}` : '',
        keyFromEnv: Boolean(process.env.DOUBAO_API_KEY),
        resourceId: s.doubao.resourceId,
      },
    };
  }

  update(patch: SettingsPatch): void {
    if (patch.agent?.backend && !AGENT_BACKENDS.includes(patch.agent.backend as AgentBackend)) {
      throw new Error(t('未知的 Agent 后端：{backend}', { backend: patch.agent.backend }));
    }
    this.settings = merge(this.settings, patch);
    if (patch.vaultPath) this.vaultOverride = undefined;
    this.save();
  }

  private save(): void {
    const file = configFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}
