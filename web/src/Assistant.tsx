import { ArrowUp, Ban, Check, ChevronRight, CircleAlert, Loader2, MessageSquare, Plus, RotateCcw, ShieldQuestion, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { latestSuggestions, visibleReply } from '../../src/shared/assistant';
import { t } from '../../src/shared/i18n';
import type { AgentBackend, ArxivHit, AssistantAction, AssistantSession, AssistantSessionMeta, Job, PaperSummary } from '../../src/shared/types';
import { EffortSelect, HarnessPicker, ModelSelect, Thinking, effortsOf } from './ChatPanel';
import { agentsStore, api, bumpLibrary, confirmAction, fail, formatDate, jobsStore, loadAgents, ownerHref, paperHref, settingsStore, toast, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import { save as saveSettings } from './Settings';
import { MessageChips, Select } from './ui';

const href = (id?: string) => (id ? `#/assistant/${id}` : '#/assistant');

const starters = () => [
  t('书架里哪些论文还没有播客？'),
  t('帮我找几篇和最新添加的论文相近的工作'),
  t('给最近添加的 3 篇论文各生成一期播客脚本'),
  t('给还没有标签的论文生成标签'),
];

export function Assistant({ sessionId }: { sessionId?: string }) {
  const { data: sessions } = useFetch<AssistantSessionMeta[]>('/assistant/sessions');
  const jobs = useStore(jobsStore);
  const running = useMemo(() => new Set(Object.values(jobs).filter((j) => j.kind === 'assistant' && j.status === 'running').map((j) => j.targetId)), [jobs]);

  const remove = async (id: string) => {
    if (!(await confirmAction(t('把这个会话移到 Vault 回收站？'), t('删除')))) return;
    try {
      await api(`/assistant/sessions/${id}`, { method: 'DELETE' });
      if (id === sessionId) location.hash = href();
      bumpLibrary();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="assistant">
      <aside className="assistant-side">
        <a className="btn assistant-new" href={href()}><Plus size={14} />{t('新建会话')}</a>
        <div className="chat-history">
          {sessions?.length === 0 && <p className="muted empty">{t('还没有会话记录')}</p>}
          {sessions?.map((s) => (
            <div className={`history-row ${s.id === sessionId ? 'on' : ''}`} key={s.id}>
              <a className="history-open" href={href(s.id)}>
                <span className="history-title">{s.title}</span>
                <span className="history-meta">
                  <MessageSquare size={11} />
                  {s.harness} · {formatDate(s.updatedAt)}
                  {running.has(s.id) && <span className="dot live" />}
                  {s.pending > 0 && <span className="assistant-badge">{t('{count} 项待审批', { count: s.pending })}</span>}
                </span>
              </a>
              <button className="icon danger" title={t('删除这个会话')} onClick={() => remove(s.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </aside>
      <Conversation key={sessionId ?? 'new'} sessionId={sessionId} />
    </div>
  );
}

function Conversation({ sessionId }: { sessionId?: string }) {
  const { data: session, setData: setSession } = useFetch<AssistantSession>(sessionId ? `/assistant/sessions/${sessionId}` : null);
  const jobs = useStore(jobsStore);
  const running: Job | undefined = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'assistant' && j.status === 'running' && j.targetId === sessionId),
    [jobs, sessionId],
  );
  const settings = useStore(settingsStore)!;
  const agents = useStore(agentsStore);
  const installed = agents?.filter((a) => a.installed).map((a) => a.backend);
  const [picked, setPicked] = useState<AgentBackend | null>(null);
  const draftHarness = picked ?? (installed?.includes(settings.agent.backend) ? settings.agent.backend : installed?.[0]);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftThinking, setDraftThinking] = useState<string | null>(null);
  const harness = sessionId ? session?.harness : draftHarness;
  const model = sessionId ? (session?.model ?? '') : (draftModel ?? (draftHarness ? settings.agent.models[draftHarness] : '') ?? '');
  const thinking = sessionId ? (session?.thinking ?? '') : (draftThinking ?? (draftHarness ? settings.agent.thinking[draftHarness] : '') ?? '');
  const agent = agents?.find((a) => a.backend === harness);
  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  const streamed = running ? visibleReply(running.text) : '';
  const waiting = messages.flatMap((m) => m.actions ?? []).filter((a) => a.status === 'pending').length;
  const actionCount = messages.flatMap((m) => m.actions ?? []).filter((a) => a.status !== 'running').length;
  /** The reply already answered, until the session catches up with the new message. */
  const [answered, setAnswered] = useState<string>();
  const suggestions = latestSuggestions(messages, Boolean(running) || answered === messages.at(-1)?.at);

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, actionCount, streamed, suggestions.length]);

  /** A chip sends only its own text, so it leaves what's being typed in place. */
  const send = async (text: string, fromChip = false) => {
    if (!text.trim() || running || !harness) return;
    if (!fromChip) setInput('');
    setAnswered(messages.at(-1)?.at);
    try {
      if (sessionId) {
        await api(`/assistant/sessions/${sessionId}/messages`, { body: { message: text } });
        bumpLibrary();
      } else {
        const res = await api<{ sessionId: string }>('/assistant/sessions', { body: { message: text, harness: draftHarness, model, thinking } });
        location.hash = href(res.sessionId);
      }
    } catch (err) {
      if (!fromChip) setInput(text);
      setAnswered(undefined);
      fail(err);
    }
  };

  const updateAgent = async (nextModel: string, nextThinking: string) => {
    if (!sessionId) {
      setDraftModel(nextModel);
      setDraftThinking(nextThinking);
      return;
    }
    try {
      setSession(await api<AssistantSession>(`/assistant/sessions/${sessionId}`, { method: 'PATCH', body: { model: nextModel, thinking: nextThinking } }));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <section className="chat assistant-main">
      <div className="chat-log" ref={logRef}>
        <div className="assistant-column">
          {!sessionId && (
            <div className="chat-empty">
              <p className="serif">{t('整个书架，一起打理。')}</p>
              <p className="muted">
                {t('助手能查看和整理书架里的所有论文，在 arXiv 上找相近的工作，也能批量生成内容。')}
                {settings.assistant.autoApproveReads ? t('它改动书架之前会先征得你的同意。') : t('它读取论文全文或改动书架之前会先征得你的同意。')}
              </p>
              <MessageChips items={starters()} disabled={!draftHarness} onPick={(s) => send(s, true)} />
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div className="msg user" key={i}>{m.content}</div>
            ) : (
              <div className={`msg ai ${m.error ? 'err' : ''}`} key={i}>
                {m.error ? <p>{m.content}</p> : m.content && <Markdown source={m.content} />}
                {m.actions && sessionId && <Actions sessionId={sessionId} actions={m.actions} locked={Boolean(running)} onSession={setSession} />}
                {m.agent && <div className="msg-agent mono">{m.agent}</div>}
              </div>
            ),
          )}
          {running && (
            <div className="msg ai">
              {streamed ? (
                <Markdown source={streamed} />
              ) : (
                <Thinking text={running.progress?.note ?? t('{agent} 正在思考', { agent: harness ?? 'AI' })} />
              )}
            </div>
          )}
          <MessageChips className="next-steps" label={t('接下来可以问')} items={suggestions} onPick={(s) => send(s, true)} />
        </div>
      </div>

      <div className="chat-input">
        <div className="assistant-column">
          {!sessionId && (
            <HarnessPicker
              installed={installed}
              detecting={!agents}
              value={draftHarness}
              onChange={(id) => {
                setPicked(id);
                setDraftModel(null);
                setDraftThinking(null);
              }}
            />
          )}
          {waiting > 0 && (
            <button className="assistant-waiting" onClick={() => logRef.current?.querySelector('.approval')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
              <ShieldQuestion size={13} />
              {t('{count} 项操作等待批准，你可以先继续提问', { count: waiting })}
            </button>
          )}
          <div className="chat-box">
            <textarea
              rows={2}
              autoFocus
              aria-label={t('问问助手')}
              placeholder={t('问问助手，或让它做点什么')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <div className="chat-actions">
              {harness && (
                <>
                  <ModelSelect
                    agent={agent}
                    value={model}
                    onChange={(next) => void updateAgent(next, effortsOf(agent, next).includes(thinking) ? thinking : '')}
                  />
                  <EffortSelect agent={agent} model={model} value={thinking} onChange={(next) => updateAgent(model, next)} />
                </>
              )}
              <div className="spacer" />
              {running ? (
                <button className="send" title={t('停止')} onClick={() => api(`/jobs/${running.id}/cancel`, { method: 'POST' }).catch(fail)}>
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button className="send" title={t('发送')} disabled={!input.trim() || !harness} onClick={() => send(input)}>
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Actions({ sessionId, actions, locked, onSession }: { sessionId: string; actions: AssistantAction[]; locked: boolean; onSession(session: AssistantSession): void }) {
  const pending = actions.filter((a) => a.status === 'pending');
  const settled = actions.filter((a) => a.status !== 'pending');
  const retryable = actions.filter((a) => a.retry);

  const retry = async (targets: AssistantAction[]) => {
    if (targets.some((a) => a.retry === 'unsure') && !(await confirmAction(t('被中断的操作可能已经生效，重试可能会重复执行。要重试吗？'), t('重试')))) return;
    try {
      await api(`/assistant/sessions/${sessionId}/retry`, { body: { actions: targets.map((a) => a.id) } });
      bumpLibrary();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="actions">
      {settled.map((a) => <ActionRow key={a.id} action={a} locked={locked} onRetry={() => retry([a])} />)}
      {retryable.length > 1 && (
        <button className="btn ghost small action-retry-all" disabled={locked} onClick={() => retry(retryable)}>
          <RotateCcw size={13} />{t('重试这 {count} 项', { count: retryable.length })}
        </button>
      )}
      {pending.length > 0 && <ApprovalCard sessionId={sessionId} actions={pending} locked={locked} onSession={onSession} />}
    </div>
  );
}

function ApprovalCard({ sessionId, actions, locked, onSession }: { sessionId: string; actions: AssistantAction[]; locked: boolean; onSession(session: AssistantSession): void }) {
  // Starts with everything ticked, so unticking is what leaves something out.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosen = actions.filter((a) => !skipped.includes(a.id)).map((a) => a.id);
  const onlyReads = actions.every((a) => a.access === 'read');

  const decide = async (approve: string[], allowReads = false) => {
    setBusy(true);
    try {
      const reject = actions.map((a) => a.id).filter((id) => !approve.includes(id));
      await api(`/assistant/sessions/${sessionId}/decide`, { body: { approve, reject, allowReads } });
      bumpLibrary();
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const allowAlways = async () => {
    await saveSettings({ assistant: { autoApproveReads: true } });
    toast(t('已打开。可以在“设置 → 助手”里关闭'));
    await decide(chosen);
  };

  // Approving waits for this, so what runs is always what the card shows.
  const edit = async (action: AssistantAction, key: string, value: string) => {
    setBusy(true);
    try {
      onSession(await api<AssistantSession>(`/assistant/sessions/${sessionId}/actions/${action.id}`, { method: 'PATCH', body: { [key]: value } }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval" role="group" aria-label={t('需要你批准')}>
      <div className="approval-head"><ShieldQuestion size={15} />{onlyReads ? t('助手想读取论文全文') : t('需要你批准')}</div>
      <ul className="approval-list">
        {actions.map((a) => (
          <li key={a.id} className={a.tool === 'delete_paper' ? 'danger' : ''}>
            <label className="approval-item">
              {actions.length > 1 && (
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={(e) => setSkipped(e.target.checked ? skipped.filter((id) => id !== a.id) : [...skipped, a.id])}
                />
              )}
              <b className="grow">{a.summary}</b>
            </label>
            {a.options?.length ? (
              <div className="action-options">
                {a.options.map((o) => (
                  <label key={o.key} className={busy || locked ? 'disabled' : ''}>
                    <span>{o.label}</span>
                    <Select value={o.value} options={o.choices} onChange={(value) => edit(a, o.key, value)} disabled={busy || locked} />
                  </label>
                ))}
              </div>
            ) : null}
            <Details action={a} />
          </li>
        ))}
      </ul>
      <div className="approval-actions">
        {onlyReads && (
          <>
            <button className="btn ghost small" disabled={busy || locked || !chosen.length} onClick={allowAlways}>{t('以后都允许')}</button>
            <button className="btn ghost small" disabled={busy || locked || !chosen.length} onClick={() => decide(chosen, true)}>{t('本次会话都允许')}</button>
          </>
        )}
        <div className="spacer" />
        <button className="btn small" disabled={busy || locked} onClick={() => decide([])}>{actions.length > 1 ? t('全部拒绝') : t('拒绝')}</button>
        <button className="btn primary small" disabled={busy || locked || !chosen.length} onClick={() => decide(chosen)}>
          {actions.length > 1 ? t('批准 {count} 项', { count: chosen.length }) : t('批准')}
        </button>
      </div>
    </div>
  );
}

function Details({ action }: { action: AssistantAction }) {
  if (!action.details?.length) return null;
  return (
    <dl className="action-details">
      {action.details.map((d, i) => (
        <div key={i}>
          <dt>{d.label}</dt>
          <dd>
            {d.before !== undefined && <del>{d.before || t('（空）')}</del>}
            {d.before !== undefined && ' → '}
            {d.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusIcon({ status }: { status: AssistantAction['status'] }) {
  if (status === 'done') return <Check size={14} className="ok" />;
  if (status === 'failed') return <CircleAlert size={14} className="over" />;
  if (status === 'rejected' || status === 'canceled') return <Ban size={14} className="muted" />;
  return <Loader2 size={14} className="spin" />;
}

const statusText = (status: AssistantAction['status']) =>
  status === 'rejected' ? t('已拒绝') : status === 'canceled' ? t('已取消') : undefined;

function ActionRow({ action, locked, onRetry }: { action: AssistantAction; locked: boolean; onRetry(): void }) {
  const note = statusText(action.status) ?? action.note;
  const target = action.target;
  const summary = (
    <>
      <StatusIcon status={action.status} />
      <span className="grow">
        {target && action.status === 'done' ? <a href={ownerHref(target.ownerId, target.tab, target.item)}>{action.summary}</a> : action.summary}
        {note && <span className="action-note"> · {note}</span>}
      </span>
      {action.retry && (
        <button className="action-retry" disabled={locked} onClick={onRetry}><RotateCcw size={12} />{t('重试')}</button>
      )}
    </>
  );
  if (!action.hits?.length) return <div className={`action-row ${action.status}`}>{summary}</div>;
  return (
    <details className="action-hits">
      <summary className={`action-row ${action.status}`}>
        {summary}
        <ChevronRight size={14} className="action-chevron" />
      </summary>
      <ul>
        {action.hits.map((hit) => <Hit key={hit.arxivId} hit={hit} />)}
      </ul>
    </details>
  );
}

/** Clicking here is the user acting directly, so unlike the assistant's own requests it needs no approval step. */
function Hit({ hit }: { hit: ArxivHit }) {
  const [added, setAdded] = useState<string>();
  const paperId = added ?? hit.paperId;
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const { paper, duplicate } = await api<{ paper: PaperSummary; duplicate: boolean }>('/papers/arxiv', { body: { input: hit.arxivId, autoTag: settingsStore.get()?.library.autoTag } });
      setAdded(paper.id);
      toast(duplicate ? t('已经在库里：{title}', { title: paper.title }) : t('已导入：{title}', { title: paper.title }));
      bumpLibrary();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="hit">
      <div className="grow">
        <a className="serif" href={`https://arxiv.org/abs/${hit.arxivId}`} target="_blank" rel="noreferrer">{hit.title}</a>
        <div className="muted small">
          {hit.authors.slice(0, 3).join(', ')}{hit.authors.length > 3 ? t(' 等') : ''}{hit.year ? ` · ${hit.year}` : ''}
        </div>
      </div>
      {paperId ? (
        <a className="btn small ghost" href={paperHref(paperId)}>{t('已在书架中')}</a>
      ) : (
        <button className="btn small" disabled={busy} onClick={add}>{busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{t('添加')}</button>
      )}
    </li>
  );
}
