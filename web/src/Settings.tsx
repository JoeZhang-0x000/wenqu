import { Check, CircleAlert, FolderOpen, Loader2, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useState } from 'react';
import {
  AGENT_BACKENDS,
  BLOG_STYLES,
  LANGUAGES,
  PODCAST_LENGTHS,
  PODCAST_STYLES,
  SPEAKER_PAIRS,
  type AgentBackend,
  type PublicSettings,
  type SettingsPatch,
  type UiLanguage,
} from '../../src/shared/types';
import { agentsStore, api, applySettings, bumpLibrary, fail, loadAgents, settingsStore, toast, useStore } from './lib';
import { Field, Select, Switch } from './ui';

type Section = 'general' | 'agent' | 'assistant' | 'podcast' | 'blog' | 'api' | 'vault';
const sections = (): { id: Section; label: string }[] => [
  { id: 'general', label: t('通用') },
  { id: 'agent', label: t('Agent 后端') },
  { id: 'assistant', label: t('助手') },
  { id: 'podcast', label: t('播客') },
  { id: 'blog', label: t('博客') },
  { id: 'api', label: t('语音 API') },
  { id: 'vault', label: 'Vault' },
];

async function save(patch: SettingsPatch) {
  try {
    applySettings(await api<PublicSettings>('/settings', { method: 'PUT', body: patch }));
  } catch (err) {
    fail(err);
  }
}

export function SettingsDialog({ initial, onClose }: { initial?: Section; onClose(): void }) {
  const settings = useStore(settingsStore);
  const [section, setSection] = useState<Section>(initial ?? 'general');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!settings) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label={t('设置')}>
        <nav className="settings-nav">
          <h2 className="serif">{t('设置')}</h2>
          {sections().map((s) => (
            <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
              {s.label}
              {s.id === 'api' && !settings.doubao.hasKey && <span className="dot" />}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon settings-close" title={t('关闭')} onClick={onClose}><X size={18} /></button>
          {section === 'general' && <GeneralSection settings={settings} />}
          {section === 'agent' && <AgentSection settings={settings} />}
          {section === 'assistant' && <AssistantSection settings={settings} />}
          {section === 'podcast' && <PodcastSection settings={settings} />}
          {section === 'blog' && <BlogSection settings={settings} />}
          {section === 'api' && <ApiSection settings={settings} />}
          {section === 'vault' && <VaultSection settings={settings} />}
        </div>
      </div>
    </div>
  );
}

function AssistantSection({ settings }: { settings: PublicSettings }) {
  return (
    <section>
      <h3 className="serif">{t('助手')}</h3>
      <p className="muted">{t('添加、修改、删除论文和生成内容，每次都要你批准，这一点不能关闭。')}</p>
      <Switch
        checked={settings.assistant.autoApproveReads}
        onChange={(autoApproveReads) => save({ assistant: { autoApproveReads } })}
        label={t('查询书架时不用询问')}
      />
      <p className="field-hint">{t('打开后，助手可以直接读取书架和论文全文。这些内容会发送给你选择的 Agent 服务。')}</p>
    </section>
  );
}

function GeneralSection({ settings }: { settings: PublicSettings }) {
  return (
    <section>
      <h3 className="serif">{t('通用')}</h3>
      <p className="muted">{t('界面和错误提示使用的语言。生成内容的语言在播客和博客里单独设置。')}</p>
      <Field label={t('界面语言')}>
        <Select
          value={settings.uiLanguage}
          options={[
            { id: 'auto', label: t('跟随浏览器') },
            { id: 'zh', label: '中文' },
            { id: 'en', label: 'English' },
          ]}
          onChange={(uiLanguage) => save({ uiLanguage: uiLanguage as UiLanguage })}
        />
      </Field>
    </section>
  );
}

const AGENT_NAMES: Record<AgentBackend, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' };
const agentPlaceholder = (backend: AgentBackend) =>
  ({ claude: t('留空使用默认，如 sonnet'), codex: t('留空使用默认'), pi: t('留空使用 pi 的默认模型') })[backend];

function AgentSection({ settings }: { settings: PublicSettings }) {
  const status = useStore(agentsStore);
  const [refreshing, setRefreshing] = useState(false);
  const [tests, setTests] = useState<Partial<Record<AgentBackend, { busy?: boolean; ok?: boolean; text?: string }>>>({});
  const current = settings.agent.backend;

  useEffect(() => {
    void loadAgents();
  }, []);

  const test = async (backend: AgentBackend) => {
    setTests((prev) => ({ ...prev, [backend]: { busy: true } }));
    const res = await api<{ ok: boolean; error?: string; ms: number }>('/agents/test', {
      body: { backend, model: settings.agent.models[backend], thinking: settings.agent.thinking[backend] },
    }).catch((err: Error) => ({ ok: false, error: err.message, ms: 0 }));
    setTests((prev) => ({
      ...prev,
      [backend]: { ok: res.ok, text: res.ok ? t('可用，耗时 {seconds} 秒', { seconds: (res.ms / 1000).toFixed(1) }) : res.error },
    }));
  };

  return (
    <section>
      <h3 className="serif">{t('Agent 后端')}</h3>
      <p className="muted">{t('这里的选择用于生成博客和播客脚本，也是新建问答时的默认值。Agent 使用它们自己的登录状态。论文内容被当作不可信数据：Claude 和 pi 运行时禁用所有工具，Codex 运行在只读沙箱中。')}</p>
      <div className="agents">
        {AGENT_BACKENDS.map((backend) => {
          const info = status?.find((s) => s.backend === backend);
          const result = tests[backend];
          return (
            <div
              key={backend}
              className={`agent ${current === backend ? 'on' : ''}`}
              onClick={() => current !== backend && save({ agent: { backend } })}
            >
              <div className="agent-head">
                <span className="radio" />
                <b>{AGENT_NAMES[backend]}</b>
                <span className="muted mono small">
                  {!status ? t('检测中') : info?.installed ? info.version : t('未安装')}
                </span>
                <div className="spacer" />
                <button
                  className="btn ghost small"
                  disabled={!info?.installed || result?.busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void test(backend);
                  }}
                >
                  {result?.busy && <Loader2 size={12} className="spin" />}{t('测试')}
                </button>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <input
                  list={`${backend}-models`}
                  placeholder={agentPlaceholder(backend)}
                  defaultValue={settings.agent.models[backend]}
                  aria-label={t('{name} 模型', { name: AGENT_NAMES[backend] })}
                  onBlur={(e) => {
                    if (e.target.value !== settings.agent.models[backend]) {
                      void save({ agent: { models: { ...settings.agent.models, [backend]: e.target.value.trim() } } });
                    }
                  }}
                />
              </div>
              {(info?.efforts.length ?? 0) > 0 && (
                <div className="agent-effort" onClick={(e) => e.stopPropagation()}>
                  <span className="muted small">{t('思考强度')}</span>
                  <select
                    className="mono"
                    aria-label={t('思考强度')}
                    value={settings.agent.thinking[backend]}
                    onChange={(e) => save({ agent: { thinking: { ...settings.agent.thinking, [backend]: e.target.value } } })}
                  >
                    <option value="">{info?.defaultEffort ? t('默认（{model}）', { model: info.defaultEffort }) : t('默认强度')}</option>
                    {info?.efforts.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                </div>
              )}
              {result?.text && (
                <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
                  {result.ok ? <Check size={13} /> : <CircleAlert size={13} />}
                  <span>{result.text}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {status?.map((agent) => (
        <datalist id={`${agent.backend}-models`} key={agent.backend}>
          {agent.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </datalist>
      ))}
      <div className="form-actions left">
        <button
          className="btn"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await loadAgents(true);
            setRefreshing(false);
          }}
        >
          {refreshing && <Loader2 size={13} className="spin" />}{t('重新检测')}
        </button>
      </div>
    </section>
  );
}

function PodcastSection({ settings }: { settings: PublicSettings }) {
  const p = settings.podcast;
  const pair = SPEAKER_PAIRS.find((x) => x.speakers[0] === p.speakers[0])?.id ?? SPEAKER_PAIRS[0].id;
  return (
    <section>
      <h3 className="serif">{t('播客默认设置')}</h3>
      <p className="muted">{t('新建一期时预先填好这些选项，单期仍可修改。')}</p>
      <div className="row">
        <Field label={t('默认语言')} hint={t('豆包目前只有中文音色，其他语言的发音效果请先试听。')}>
          <Select value={p.language} options={LANGUAGES} onChange={(language) => save({ podcast: { language } })} />
        </Field>
        <Field label={t('默认时长')}>
          <Select value={p.length} options={PODCAST_LENGTHS} onChange={(length) => save({ podcast: { length: length as any } })} />
        </Field>
      </div>
      <Field label={t('默认风格')}>
        <Select value={p.style} options={PODCAST_STYLES} custom onChange={(style) => save({ podcast: { style } })} />
      </Field>
      {p.style === 'custom' && (
        <Field label={t('自定义风格')}>
          <textarea rows={3} defaultValue={p.customStyle} placeholder={t('描述主持人的关系、语气和节奏')} onBlur={(e) => save({ podcast: { customStyle: e.target.value } })} />
        </Field>
      )}
      <Field label={t('默认生成方式')}>
        <Select
          value={p.engine}
          options={[
            { id: 'agent', label: t('Agent 写稿'), hint: t('可选语言风格，能修改脚本') },
            { id: 'doubao', label: t('豆包直出'), hint: t('不需要 Agent') },
          ]}
          onChange={(engine) => save({ podcast: { engine: engine as any } })}
        />
      </Field>
      <Field label={t('默认主播')} hint={t('同一系列的音色配对效果更好。')}>
        <Select
          value={pair}
          options={SPEAKER_PAIRS}
          onChange={(id) => save({ podcast: { speakers: SPEAKER_PAIRS.find((x) => x.id === id)!.speakers } })}
        />
      </Field>
      <Field label={t('语速 {value}', { value: `${p.speechRate > 0 ? '+' : ''}${p.speechRate}` })}>
        <input
          type="range"
          min={-50}
          max={100}
          step={5}
          defaultValue={p.speechRate}
          onMouseUp={(e) => save({ podcast: { speechRate: Number(e.currentTarget.value) } })}
          onKeyUp={(e) => save({ podcast: { speechRate: Number(e.currentTarget.value) } })}
        />
      </Field>
      <div className="row-inline">
        <Switch checked={p.headMusic} onChange={(headMusic) => save({ podcast: { headMusic } })} label={t('片头音乐')} />
        <Switch checked={p.tailMusic} onChange={(tailMusic) => save({ podcast: { tailMusic } })} label={t('片尾音乐')} />
      </div>
    </section>
  );
}

function BlogSection({ settings }: { settings: PublicSettings }) {
  const b = settings.blog;
  return (
    <section>
      <h3 className="serif">{t('博客默认设置')}</h3>
      <p className="muted">{t('新建博客时预先填好这些选项，单篇仍可修改。')}</p>
      <Field label={t('默认语言')}>
        <Select value={b.language} options={LANGUAGES} onChange={(language) => save({ blog: { language } })} />
      </Field>
      <Field label={t('默认风格')}>
        <Select value={b.style} options={BLOG_STYLES} custom onChange={(style) => save({ blog: { style } })} />
      </Field>
      {b.style === 'custom' && (
        <Field label={t('自定义风格')}>
          <textarea rows={4} defaultValue={b.customStyle} placeholder={t('描述你想要的文风、读者和结构')} onBlur={(e) => save({ blog: { customStyle: e.target.value } })} />
        </Field>
      )}
    </section>
  );
}

function ApiSection({ settings }: { settings: PublicSettings }) {
  const d = settings.doubao;
  const [key, setKey] = useState('');
  const [resource, setResource] = useState(d.resourceId);
  const [result, setResult] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});

  const test = async () => {
    setResult({ busy: true });
    const res = await api<{ ok: boolean; error?: string; ms: number }>('/doubao/test', { body: { apiKey: key || undefined } }).catch(
      (err: Error) => ({ ok: false, error: err.message, ms: 0 }),
    );
    setResult({ ok: res.ok, text: res.ok ? t('连接正常，耗时 {seconds} 秒', { seconds: (res.ms / 1000).toFixed(1) }) : res.error });
  };

  return (
    <section>
      <h3 className="serif">{t('豆包语音')}</h3>
      <p className="muted">
        {t('合成音频前需要先配置。')}{' '}
        <a href="https://console.volcengine.com/speech/service" target="_blank" rel="noreferrer">{t('在火山引擎控制台开通语音播客服务后获取 API Key。')}</a>{' '}
        {t('Key 只保存在本机配置文件中，不会写入 Vault。')}
      </p>
      <Field
        label="API Key"
        hint={d.keyFromEnv ? t('当前由环境变量 DOUBAO_API_KEY 提供，它的优先级高于这里的设置。') : d.hasKey ? t('已配置 {preview}，留空表示不修改。', { preview: d.keyPreview }) : undefined}
      >
        <input type="password" autoComplete="off" value={key} placeholder={d.hasKey ? d.keyPreview : t('粘贴 API Key')} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <Field label="Resource ID" hint={t('一般不需要修改。')}>
        <input value={resource} onChange={(e) => setResource(e.target.value)} onBlur={() => resource !== d.resourceId && save({ doubao: { resourceId: resource.trim() } })} />
      </Field>
      <div className="form-actions left">
        <button
          className="btn primary"
          disabled={!key.trim()}
          onClick={async () => {
            await save({ doubao: { apiKey: key } });
            setKey('');
            toast(t('API Key 已保存'));
          }}
        >
          {t('保存 Key')}
        </button>
        <button className="btn" disabled={result.busy || (!key && !d.hasKey)} onClick={test}>
          {result.busy && <Loader2 size={13} className="spin" />}{t('测试连接')}
        </button>
        {d.hasKey && !d.keyFromEnv && (
          <button className="btn ghost" onClick={() => save({ doubao: { apiKey: '' } })}>{t('移除 Key')}</button>
        )}
      </div>
      {result.text && (
        <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
          {result.ok ? <Check size={13} /> : <CircleAlert size={13} />}
          <span>{result.text}</span>
        </div>
      )}
      <p className="muted small">{t('测试会合成一句很短的语音，消耗极少的额度。')}</p>
    </section>
  );
}

function VaultSection({ settings }: { settings: PublicSettings }) {
  const [path, setPath] = useState(settings.vaultPath);
  const changed = path.trim() !== settings.vaultPath;
  return (
    <section>
      <h3 className="serif">Vault</h3>
      <p className="muted">{t('所有论文和生成内容都以普通文件的形式存放在这个目录里。删除的内容会移到其中的 .trash 文件夹。')}</p>
      <Field label={t('位置')} hint={t('切换后不会移动原有文件。把旧目录中的 papers 文件夹拷过去，即可继续使用。')}>
        <div className="input-with-icon">
          <FolderOpen size={15} />
          <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
        </div>
      </Field>
      <div className="form-actions left">
        <button
          className="btn primary"
          disabled={!changed || !path.trim()}
          onClick={async () => {
            await save({ vaultPath: path.trim() });
            bumpLibrary();
            toast(t('Vault 已切换'));
          }}
        >
          {t('切换 Vault')}
        </button>
      </div>
    </section>
  );
}
