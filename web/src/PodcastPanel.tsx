import { AudioLines, Download, KeyRound, Pause, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { getLocale, t, tx } from '../../src/shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLLECTION_MODES,
  LANGUAGES,
  MAX_ROUND_CHARS,
  MAX_SCRIPT_CHARS,
  PODCAST_LENGTHS,
  PODCAST_STYLES,
  SPEAKER_PAIRS,
  isCollectionId,
  type Job,
  type Podcast,
  type PodcastEngine,
  type ScriptRound,
} from '../../src/shared/types';
import { Thinking } from './ChatPanel';
import { api, bumpLibrary, confirmAction, fail, formatDate, formatTime, jobsStore, player, playerStore, settingsStore, toast, useFetch, useStore } from './lib';
import { Field, Progress, Select, Switch } from './ui';

export const speakerNames = (speakers: [string, string]) => {
  const pair = SPEAKER_PAIRS.find((p) => p.speakers[0] === speakers[0] && p.speakers[1] === speakers[1]);
  return pairNames(pair);
};

const pairNames = (pair?: (typeof SPEAKER_PAIRS)[number]) => {
  if (!pair) return ['A', 'B'];
  return getLocale() === 'zh' ? pair.names : pair.namesEn;
};

const pairId = (speakers: [string, string]) => SPEAKER_PAIRS.find((p) => p.speakers[0] === speakers[0])?.id ?? SPEAKER_PAIRS[0].id;

const styleLabel = (id: string) => {
  const label = PODCAST_STYLES.find((s) => s.id === id)?.label;
  return label ? tx(label) : id === 'custom' ? t('自定义') : id;
};

const statusLabel = (status: Podcast['status']) =>
  ({ draft: t('脚本'), synthesizing: t('合成中'), ready: '', failed: t('失败') })[status];

export function PodcastPanel({
  paperId,
  initialItem,
  agentName,
  onOpenSettings,
}: {
  paperId: string;
  initialItem?: string;
  agentName: string;
  onOpenSettings(): void;
}) {
  const { data: podcasts } = useFetch<Podcast[]>(`/papers/${paperId}/podcasts`);
  const jobs = useStore(jobsStore);
  const scriptJob = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'script' && j.paperId === paperId && j.status === 'running'),
    [jobs, paperId],
  );
  const [failure, setFailure] = useState<string>();
  const [selected, setSelected] = useState<string | undefined>(initialItem);
  const [composing, setComposing] = useState(false);
  const [lastStarted, setLastStarted] = useState<string>();

  useEffect(() => setSelected(initialItem), [initialItem]);

  useEffect(() => {
    if (!podcasts) return;
    if (lastStarted && podcasts.some((p) => p.id === lastStarted)) {
      setSelected(lastStarted);
      setLastStarted(undefined);
    } else if (!selected || !podcasts.some((p) => p.id === selected)) {
      setSelected(podcasts[0]?.id);
    }
  }, [podcasts]);

  // A script job leaves no record on failure, so its error is surfaced here.
  useEffect(() => {
    if (!lastStarted || scriptJob) return;
    const job = Object.values(jobs).find((j) => j.targetId === lastStarted && j.kind === 'script');
    if (job?.status === 'failed' || job?.status === 'canceled') {
      setFailure(job.status === 'failed' ? job.error : undefined);
      setLastStarted(undefined);
      setComposing(true);
    }
  }, [jobs, lastStarted, scriptJob]);

  const showForm = composing || (podcasts !== undefined && podcasts.length === 0 && !scriptJob && !lastStarted);

  return (
    <div className="panel-body">
      {podcasts && podcasts.length > 0 && (
        <div className="versions">
          <select value={selected ?? ''} onChange={(e) => { setSelected(e.target.value); setComposing(false); }}>
            {podcasts.map((p) => (
              <option key={p.id} value={p.id}>{p.status !== 'ready' ? `[${statusLabel(p.status)}] ` : ''}{p.title}</option>
            ))}
          </select>
          <button className="btn" disabled={Boolean(scriptJob)} onClick={() => setComposing(!composing)}>
            <Plus size={14} />{t('新一期')}
          </button>
        </div>
      )}
      {scriptJob ? (
        <ScriptStream job={scriptJob} agentName={agentName} />
      ) : showForm ? (
        <PodcastForm
          paperId={paperId}
          error={failure}
          onOpenSettings={onOpenSettings}
          onStarted={(id) => {
            setFailure(undefined);
            setLastStarted(id);
            setComposing(false);
          }}
          onCancel={podcasts?.length ? () => setComposing(false) : undefined}
        />
      ) : selected ? (
        <PodcastView key={selected} paperId={paperId} podcastId={selected} onOpenSettings={onOpenSettings} />
      ) : null}
    </div>
  );
}

function ScriptStream({ job, agentName }: { job: Job; agentName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.text]);
  const lines = job.text.split('\n').filter((l) => l.trim());
  return (
    <div className="scroll" ref={ref}>
      <div className="stream-head">
        <span className="muted">{t('正在写脚本')} · {agentName}</span>
        <button className="btn ghost" onClick={() => api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(fail)}>
          <Square size={12} fill="currentColor" />{t('停止')}
        </button>
      </div>
      {lines.length ? (
        <div className="transcript">
          {lines.map((line, i) => {
            const speaker = line.trim().match(/^([AB])[:：]/)?.[1];
            return (
              <div className={`line ${speaker === 'B' ? 'b' : speaker === 'A' ? 'a' : 'title-line'}`} key={i}>
                {line.replace(/^([AB]|TITLE)[:：]\s*/, '')}
              </div>
            );
          })}
        </div>
      ) : (
        <Thinking text={t('{agent} 正在阅读论文', { agent: agentName })} />
      )}
    </div>
  );
}

function KeyNotice({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <div className="notice">
      <KeyRound size={14} />
      <span>{t('合成音频需要豆包语音 API Key。脚本可以先写好。')}</span>
      <button className="link" onClick={onOpenSettings}>{t('去设置')}</button>
    </div>
  );
}

function PodcastForm({
  paperId,
  error,
  onStarted,
  onCancel,
  onOpenSettings,
}: {
  paperId: string;
  error?: string;
  onStarted(id: string): void;
  onCancel?: () => void;
  onOpenSettings(): void;
}) {
  const settings = useStore(settingsStore)!;
  const defaults = settings.podcast;
  const collection = isCollectionId(paperId);
  const [engine, setEngine] = useState<PodcastEngine>(collection ? 'agent' : defaults.engine);
  const [mode, setMode] = useState('digest');
  const [language, setLanguage] = useState(defaults.language);
  const [style, setStyle] = useState(defaults.style);
  const [customStyle, setCustomStyle] = useState(defaults.customStyle);
  const [length, setLength] = useState<string>(defaults.length);
  const [pair, setPair] = useState(pairId(defaults.speakers));
  const [instructions, setInstructions] = useState('');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasKey = settings.doubao.hasKey;
  const needsKeyNow = engine === 'doubao' && !hasKey;

  return (
    <div className="scroll form">
      <h3 className="serif">{collection ? t('把这个合集做成一期播客') : t('做一期播客')}</h3>
      {!hasKey && <KeyNotice onOpenSettings={onOpenSettings} />}
      {collection ? (
        <Field label={t('形式')}><Select value={mode} options={COLLECTION_MODES} onChange={setMode} /></Field>
      ) : (
        <div className="segmented">
          <button className={engine === 'agent' ? 'on' : ''} onClick={() => setEngine('agent')}>
            <b>{t('Agent 写稿')}</b><span>{t('可选语言和风格，能修改脚本')}</span>
          </button>
          <button className={engine === 'doubao' ? 'on' : ''} onClick={() => setEngine('doubao')}>
            <b>{t('豆包直出')}</b><span>{t('由豆包总结生成，不需要 Agent')}</span>
          </button>
        </div>
      )}
      {engine === 'agent' ? (
        <>
          <div className="row">
            <Field label={t('语言')}><Select value={language} options={LANGUAGES} onChange={setLanguage} /></Field>
            <Field label={t('时长')}><Select value={length} options={PODCAST_LENGTHS} onChange={setLength} /></Field>
          </div>
          <Field label={t('风格')}><Select value={style} options={PODCAST_STYLES} onChange={setStyle} custom /></Field>
          {style === 'custom' && (
            <Field label={t('自定义风格')}>
              <textarea rows={3} value={customStyle} placeholder={t('描述主持人的关系、语气和节奏')} onChange={(e) => setCustomStyle(e.target.value)} />
            </Field>
          )}
        </>
      ) : (
        <div className="notice subtle">{t('豆包直出不支持指定风格和时长，只取论文前 20,000 字符。')}</div>
      )}
      <Field label={t('主播')}>
        <Select value={pair} options={SPEAKER_PAIRS} onChange={setPair} />
      </Field>
      {engine === 'agent' && (
        <>
          <Field label={t('额外要求（可选）')}>
            <textarea rows={2} value={instructions} placeholder={t('例如：多讲实验设计，少讲相关工作')} onChange={(e) => setInstructions(e.target.value)} />
          </Field>
          {hasKey && <Switch checked={auto} onChange={setAuto} label={t('写完脚本后直接合成音频')} />}
        </>
      )}
      {error && <div className="notice err">{t('上次生成失败：{error}', { error })}</div>}
      <div className="form-actions">
        {onCancel && <button className="btn ghost" onClick={onCancel}>{t('取消')}</button>}
        <button
          className="btn primary"
          disabled={busy || needsKeyNow}
          onClick={async () => {
            setBusy(true);
            try {
              const speakers = SPEAKER_PAIRS.find((p) => p.id === pair)!.speakers;
              const res = await api<{ podcastId: string }>(`/papers/${paperId}/podcasts`, {
                body: { engine, language, style, customStyle, length, speakers, instructions, autoSynthesize: auto, mode },
              });
              onStarted(res.podcastId);
              bumpLibrary();
            } catch (err) {
              fail(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {engine === 'agent' ? t('开始写脚本') : t('开始生成')}
        </button>
      </div>
    </div>
  );
}

function PodcastView({ paperId, podcastId, onOpenSettings }: { paperId: string; podcastId: string; onOpenSettings(): void }) {
  const { data: podcast, setData } = useFetch<Podcast>(`/papers/${paperId}/podcasts/${podcastId}`);
  const [editing, setEditing] = useState(false);
  const settings = useStore(settingsStore)!;
  const jobs = useStore(jobsStore);
  const job = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'synth' && j.targetId === podcastId && j.status === 'running'),
    [jobs, podcastId],
  );
  if (!podcast) return null;

  const remove = async () => {
    if (await confirmAction(t('把「{title}」移到 Vault 回收站？', { title: podcast.title }), t('删除'))) {
      if (playerStore.get().podcast?.id === podcast.id) player.close();
      await api(`/papers/${paperId}/podcasts/${podcastId}`, { method: 'DELETE' }).catch(fail);
      bumpLibrary();
    }
  };

  const meta = (
    <div className="item-meta">
      <span className="muted">
        {podcast.mode ? `${tx(COLLECTION_MODES.find((m) => m.id === podcast.mode)?.label ?? '')} · ` : ''}
        {podcast.engine === 'doubao' ? t('豆包直出') : styleLabel(podcast.style)} ·{' '}
        {LANGUAGES.find((l) => l.id === podcast.language)?.label ?? podcast.language} · {podcast.agent ? `${podcast.agent} · ` : ''}
        {formatDate(podcast.createdAt)}
      </span>
      <div className="spacer" />
      {podcast.status === 'ready' && !editing && (
        <>
          <button className="icon" title={t('修改脚本后重新合成')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
          <a className="icon" title={t('下载 MP3')} href={`/api/papers/${paperId}/podcasts/${podcastId}/audio?download=1`}><Download size={14} /></a>
        </>
      )}
      {!job && <button className="icon danger" title={t('删除')} onClick={remove}><Trash2 size={14} /></button>}
    </div>
  );

  if (job || podcast.status === 'synthesizing') {
    return (
      <div className="scroll">
        {meta}
        <h3 className="serif">{podcast.title}</h3>
        <div className="synth">
          <AudioLines size={18} className="pulse" />
          <div className="grow">
            <div className="synth-note">{job?.progress?.note ?? t('正在合成')}{job?.progress?.total ? ` / ${t('共 {count} 轮', { count: job.progress.total })}` : ''}</div>
            <Progress done={job?.progress?.done ?? 0} total={job?.progress?.total} />
          </div>
          {job && <button className="btn ghost" onClick={() => api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(fail)}>{t('取消')}</button>}
        </div>
        <p className="muted small">{t('可以关闭这个页面，合成会在后台继续，完成后可在这里收听。')}</p>
      </div>
    );
  }

  if (podcast.status === 'ready' && !editing) {
    return <PodcastPlayerView paperId={paperId} podcast={podcast} meta={meta} />;
  }

  return (
    <ScriptEditor
      paperId={paperId}
      podcast={podcast}
      meta={meta}
      hasKey={settings.doubao.hasKey}
      onOpenSettings={onOpenSettings}
      onCancel={podcast.status === 'ready' ? () => setEditing(false) : undefined}
      onSaved={(next) => {
        setData(next);
        setEditing(false);
      }}
    />
  );
}

function PodcastPlayerView({ paperId, podcast, meta }: { paperId: string; podcast: Podcast; meta: React.ReactNode }) {
  const state = useStore(playerStore);
  const isCurrent = state.podcast?.id === podcast.id;
  const names = speakerNames(podcast.speakers);
  const activeRef = useRef<HTMLButtonElement>(null);
  const active = isCurrent ? podcast.rounds.findIndex((r) => r.start !== undefined && state.time >= r.start && state.time < (r.end ?? Infinity)) : -1;

  useEffect(() => {
    if (state.playing) activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, state.playing]);

  return (
    <div className="scroll">
      {meta}
      <div className="episode">
        <button
          className="play-big"
          title={isCurrent && state.playing ? t('暂停') : t('播放')}
          onClick={() => (isCurrent ? player.toggle() : player.play(paperId, podcast))}
        >
          {isCurrent && state.playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
        </button>
        <div className="grow">
          <h3 className="serif">{podcast.title}</h3>
          <div className="muted small mono">
            {formatTime(podcast.duration)} · {t('{count} 轮', { count: podcast.rounds.length })} · {names.join(' × ')}
          </div>
        </div>
      </div>
      {podcast.inputTruncated && <div className="notice subtle">{t('论文内容超过豆包的输入上限，生成时被截断了。')}</div>}
      <div className="transcript">
        {podcast.rounds.map((round, i) => (
          <button
            key={i}
            ref={i === active ? activeRef : undefined}
            className={`line ${round.speaker === 1 ? 'b' : 'a'} ${i === active ? 'active' : ''}`}
            onClick={() => player.play(paperId, podcast, round.start ?? 0)}
          >
            <span className="line-who">{names[round.speaker]}</span>
            {round.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScriptEditor({
  paperId,
  podcast,
  meta,
  hasKey,
  onOpenSettings,
  onSaved,
  onCancel,
}: {
  paperId: string;
  podcast: Podcast;
  meta: React.ReactNode;
  hasKey: boolean;
  onOpenSettings(): void;
  onSaved(p: Podcast): void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(podcast.title);
  const [rounds, setRounds] = useState<ScriptRound[]>(podcast.rounds);
  const [pair, setPair] = useState(pairId(podcast.speakers));
  const [speechRate, setSpeechRate] = useState(podcast.speechRate);
  const [headMusic, setHeadMusic] = useState(podcast.headMusic);
  const [tailMusic, setTailMusic] = useState(podcast.tailMusic);
  const [busy, setBusy] = useState(false);
  const names = pairNames(SPEAKER_PAIRS.find((p) => p.id === pair));
  const total = rounds.reduce((n, r) => n + r.text.length, 0);
  const longRound = rounds.findIndex((r) => r.text.length > MAX_ROUND_CHARS);
  const tooLong = total > MAX_SCRIPT_CHARS;
  const issue = !rounds.length ? t('脚本为空') : tooLong ? t('总长超过 {limit} 字符', { limit: MAX_SCRIPT_CHARS }) : longRound >= 0 ? t('第 {round} 轮超过 {limit} 字符', { round: longRound + 1, limit: MAX_ROUND_CHARS }) : null;

  const patch = (i: number, next: Partial<ScriptRound>) => setRounds(rounds.map((r, j) => (j === i ? { ...r, ...next } : r)));

  const save = () =>
    api<Podcast>(`/papers/${paperId}/podcasts/${podcast.id}`, {
      method: 'PUT',
      body: { title, rounds, speakers: SPEAKER_PAIRS.find((p) => p.id === pair)!.speakers, speechRate, headMusic, tailMusic },
    });

  return (
    <div className="scroll script">
      {meta}
      {podcast.status === 'failed' && (
        <div className="notice err">
          {t('合成失败：{error}', { error: podcast.error ?? '' })}
          {!rounds.length && t('（这一期没有脚本可以重试，请新建一期。）')}
        </div>
      )}
      {!hasKey && <KeyNotice onOpenSettings={onOpenSettings} />}
      <input className="script-title serif" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('标题')} />
      <div className="row">
        <Field label={t('主播')}><Select value={pair} options={SPEAKER_PAIRS} onChange={setPair} /></Field>
        <Field label={t('语速 {value}', { value: `${speechRate > 0 ? '+' : ''}${speechRate}` })}>
          <input type="range" min={-50} max={100} step={5} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} />
        </Field>
      </div>
      <div className="row-inline">
        <Switch checked={headMusic} onChange={setHeadMusic} label={t('片头音乐')} />
        <Switch checked={tailMusic} onChange={setTailMusic} label={t('片尾音乐')} />
      </div>
      <div className="rounds">
        {rounds.map((round, i) => (
          <div className={`round ${round.speaker === 1 ? 'b' : 'a'}`} key={i}>
            <div className="round-head">
              <button className="round-who" title={t('切换主播')} onClick={() => patch(i, { speaker: round.speaker === 1 ? 0 : 1 })}>
                {names[round.speaker]}
              </button>
              <span className={`mono small ${round.text.length > MAX_ROUND_CHARS ? 'over' : 'muted'}`}>{round.text.length}</span>
              <div className="spacer" />
              <button className="icon" title={t('在下方插入一轮')} onClick={() => setRounds([...rounds.slice(0, i + 1), { speaker: round.speaker === 1 ? 0 : 1, text: '' }, ...rounds.slice(i + 1)])}>
                <Plus size={13} />
              </button>
              <button className="icon" title={t('删除这一轮')} onClick={() => setRounds(rounds.filter((_, j) => j !== i))}><X size={13} /></button>
            </div>
            <AutoTextarea value={round.text} onChange={(text) => patch(i, { text })} />
          </div>
        ))}
      </div>
      <div className="script-foot">
        <span className={`mono small ${tooLong ? 'over' : 'muted'}`}>{total.toLocaleString()} / {MAX_SCRIPT_CHARS.toLocaleString()}</span>
        {issue && <span className="over small">{issue}</span>}
        <div className="spacer" />
        {onCancel && <button className="btn ghost" onClick={onCancel}>{t('取消')}</button>}
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onSaved(await save());
              toast(t('已保存'));
            } catch (err) {
              fail(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('保存')}
        </button>
        <button
          className="btn primary"
          disabled={busy || Boolean(issue) || !hasKey}
          onClick={async () => {
            setBusy(true);
            try {
              const saved = await save();
              // The loaded audio is about to be replaced.
              if (playerStore.get().podcast?.id === podcast.id) player.close();
              await api(`/papers/${paperId}/podcasts/${podcast.id}/synthesize`, { method: 'POST' });
              onSaved({ ...saved, status: 'synthesizing' });
              bumpLibrary();
            } catch (err) {
              fail(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <AudioLines size={14} />{t('合成音频')}
        </button>
      </div>
    </div>
  );
}

function AutoTextarea({ value, onChange }: { value: string; onChange(v: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} />;
}
