import { ArrowUp, History, MessageSquare, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { latestSuggestions, visibleAnswer } from '../../src/shared/assistant';
import { t } from '../../src/shared/i18n';
import type { AgentBackend, AgentStatus, ChatMessage, ChatSession, ChatSessionMeta, Job } from '../../src/shared/types';
import { agentsStore, api, bumpLibrary, confirmAction, fail, formatDate, jobsStore, loadAgents, settingsStore, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import type { SelectionAsk } from './PdfViewer';
import { MessageChips } from './ui';

const starters = () => [t('一句话总结这篇论文'), t('核心贡献是什么？'), t('方法的关键步骤是什么？'), t('有哪些局限和未解决的问题？')];

export function ChatPanel({
  paperId,
  ask,
  onCite,
}: {
  paperId: string;
  ask: (SelectionAsk & { nonce: number }) | null;
  onCite(page: number): void;
}) {
  const { data: sessions } = useFetch<ChatSessionMeta[]>(`/papers/${paperId}/chats`);
  /** null is a new chat that doesn't exist until its first question. */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const opened = useRef(false);
  const { data: session, setData: setSession } = useFetch<ChatSession>(sessionId ? `/papers/${paperId}/chats/${sessionId}` : null);
  const jobs = useStore(jobsStore);
  const runningJobs = useMemo(() => Object.values(jobs).filter((j) => j.kind === 'chat' && j.paperId === paperId && j.status === 'running'), [jobs, paperId]);
  const running: Job | undefined = runningJobs.find((j) => j.targetId === sessionId);
  const settings = useStore(settingsStore)!;
  const agents = useStore(agentsStore);
  const installed = agents?.filter((a) => a.installed).map((a) => a.backend);
  /** What a new chat will use. A started chat keeps the harness it was created with. */
  const [pickedHarness, setPickedHarness] = useState<AgentBackend | null>(null);
  const draftHarness = pickedHarness ?? (installed?.includes(settings.agent.backend) ? settings.agent.backend : installed?.[0]);
  const sessionHarness = sessions?.find((s) => s.id === sessionId)?.harness ?? (session?.id === sessionId ? session?.harness : undefined);
  const harness = sessionId ? sessionHarness : draftHarness;
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftThinking, setDraftThinking] = useState<string | null>(null);
  const current = session?.id === sessionId ? session : undefined;
  const model = sessionId ? (current?.model ?? '') : (draftModel ?? (draftHarness ? settings.agent.models[draftHarness] : '') ?? '');
  const thinking = sessionId ? (current?.thinking ?? '') : (draftThinking ?? (draftHarness ? settings.agent.thinking[draftHarness] : '') ?? '');
  const agent = agents?.find((a) => a.backend === harness);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState<{ text: string; page?: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledAsk = useRef<number>(0);
  const messages = sessionId && session?.id === sessionId ? session.messages : [];
  const streamed = running ? visibleAnswer(running.text) : '';
  /** The reply already answered, until the session catches up with the new message. */
  const [answered, setAnswered] = useState<string>();
  const suggestions = latestSuggestions(messages, Boolean(running) || answered === messages.at(-1)?.at);

  useEffect(() => {
    void loadAgents();
  }, []);

  // Picks up where you left off, once per paper.
  useEffect(() => {
    if (!sessions || opened.current) return;
    opened.current = true;
    if (sessions[0]) setSessionId(sessions[0].id);
  }, [sessions]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, streamed, showHistory, suggestions.length]);

  /** A chip sends only its own text, so it leaves what's being typed and any quote in place. */
  const send = async (text: string, selection?: { text: string; page?: number } | null, fromChip = false) => {
    if (!text.trim() || running) return;
    if (!fromChip) {
      setInput('');
      setQuote(null);
    }
    setAnswered(messages.at(-1)?.at);
    setShowHistory(false);
    const body = { message: text, selection: selection?.text, page: selection?.page };
    try {
      if (sessionId) {
        const res = await api<{ message: ChatMessage }>(`/papers/${paperId}/chats/${sessionId}/messages`, { body });
        setSession((current) => (current ? { ...current, messages: [...current.messages, res.message] } : current));
      } else {
        const res = await api<{ sessionId: string }>(`/papers/${paperId}/chats`, { body: { ...body, harness: draftHarness, model, thinking } });
        setSessionId(res.sessionId);
      }
    } catch (err) {
      if (!fromChip) setInput(text);
      setAnswered(undefined);
      fail(err);
    }
  };

  useEffect(() => {
    if (!ask || handledAsk.current === ask.nonce) return;
    handledAsk.current = ask.nonce;
    const selection = { text: ask.selection, page: ask.page };
    setShowHistory(false);
    if (ask.prompt && !running) {
      void send(ask.prompt, selection);
    } else {
      setQuote(selection);
      inputRef.current?.focus();
    }
  }, [ask]);

  const startNew = () => {
    setSessionId(null);
    setShowHistory(false);
    setQuote(null);
    inputRef.current?.focus();
  };

  const updateAgent = async (nextModel: string, nextThinking: string) => {
    if (!sessionId) {
      setDraftModel(nextModel);
      setDraftThinking(nextThinking);
      return;
    }
    try {
      setSession(await api<ChatSession>(`/papers/${paperId}/chats/${sessionId}`, { method: 'PATCH', body: { model: nextModel, thinking: nextThinking } }));
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (id: string) => {
    if (!(await confirmAction(t('把这个会话移到 Vault 回收站？'), t('删除')))) return;
    try {
      await api(`/papers/${paperId}/chats/${id}`, { method: 'DELETE' });
      if (id === sessionId) setSessionId(null);
      bumpLibrary();
    } catch (err) {
      fail(err);
    }
  };

  const title = sessions?.find((s) => s.id === sessionId)?.title ?? t('新会话');

  return (
    <div className="chat">
      <div className="chat-bar">
        <button className={`icon ${showHistory ? 'on' : ''}`} title={showHistory ? t('返回当前会话') : t('历史会话')} onClick={() => setShowHistory(!showHistory)}>
          <History size={15} />
        </button>
        <span className="chat-title" title={title}>{showHistory ? t('历史会话') : title}</span>
        {sessionId && !showHistory && harness && <span className="agent-pill mono" title={t('会话创建后不能更换 Harness')}>{harness}</span>}
        <button className="icon" title={t('新建会话')} onClick={startNew}><Plus size={15} /></button>
      </div>

      {showHistory ? (
        <div className="chat-history">
          {sessions?.length === 0 && <p className="muted empty">{t('还没有会话记录')}</p>}
          {sessions?.map((s) => (
            <div className={`history-row ${s.id === sessionId ? 'on' : ''}`} key={s.id}>
              <button
                className="history-open"
                onClick={() => {
                  setSessionId(s.id);
                  setShowHistory(false);
                }}
              >
                <span className="history-title">{s.title}</span>
                <span className="history-meta">
                  <MessageSquare size={11} />
                  {s.harness} ·
                  {t('{count} 条消息', { count: s.messageCount })} · {formatDate(s.updatedAt)}
                  {runningJobs.some((j) => j.targetId === s.id) && <span className="dot live" />}
                </span>
              </button>
              <button className="icon danger" title={t('删除这个会话')} onClick={() => remove(s.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="chat-log" ref={logRef}>
          {!sessionId && (
            <div className="chat-empty">
              <p className="serif">{t('读到哪里，问到哪里。')}</p>
              <p className="muted">{t('回答基于全文并标注页码，点击页码可跳转。也可以在左侧选中一段文字直接提问。')}</p>
              <MessageChips items={starters()} onPick={(s) => send(s, null, true)} />
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div className="msg user" key={i}>
                {m.selection && (
                  <blockquote className="quote" onClick={() => m.page && onCite(m.page)}>
                    {m.page && <span className="mono">p.{m.page}</span>} {m.selection}
                  </blockquote>
                )}
                <div>{m.content}</div>
              </div>
            ) : (
              <div className={`msg ai ${m.error ? 'err' : ''}`} key={i}>
                {m.error ? <p>{m.content}</p> : <Markdown source={m.content} onCite={onCite} />}
                {m.agent && <div className="msg-agent mono">{m.agent}</div>}
              </div>
            ),
          )}
          {running && (
            <div className="msg ai">
              {streamed ? <Markdown source={streamed} onCite={onCite} /> : <Thinking text={t('{agent} 正在阅读论文', { agent: harness ?? 'AI' })} />}
            </div>
          )}
          <MessageChips className="next-steps" label={t('接下来可以问')} items={suggestions} onPick={(s) => send(s, null, true)} />
        </div>
      )}

      <div className="chat-input">
        {!sessionId && !showHistory && (
          <HarnessPicker
            installed={installed}
            detecting={!agents}
            value={draftHarness}
            onChange={(id) => {
              setPickedHarness(id);
              setDraftModel(null);
              setDraftThinking(null);
            }}
          />
        )}
        {quote && (
          <div className="quote-chip">
            <span>{quote.page && <b className="mono">p.{quote.page} </b>}{quote.text}</span>
            <button className="icon" title={t('移除引用')} onClick={() => setQuote(null)}><X size={13} /></button>
          </div>
        )}
        <div className="chat-box">
          <textarea
            ref={inputRef}
            rows={2}
            placeholder={quote ? t('针对这段文字提问') : t('问问 {agent}', { agent: harness ?? 'AI' })}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input, quote);
              }
            }}
          />
          <div className="chat-actions">
            {harness && (
              <>
                <ModelSelect
                  agent={agent}
                  value={model}
                  onChange={(next) => {
                    // A level the new model doesn't accept falls back to its default.
                    const keep = effortsOf(agent, next).includes(thinking) ? thinking : '';
                    void updateAgent(next, keep);
                  }}
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
              <button className="send" title={t('发送')} disabled={!input.trim() || !harness} onClick={() => send(input, quote)}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The levels a model accepts. Without a chosen model, those of the harness's default. */
export function effortsOf(agent: AgentStatus | undefined, model: string): string[] {
  if (!agent) return [];
  const found = agent.models.find((m) => m.id === (model || agent.defaultModel));
  return found ? found.efforts : agent.efforts;
}

export function EffortSelect({ agent, model, value, onChange }: { agent?: AgentStatus; model: string; value: string; onChange(level: string): void }) {
  const efforts = effortsOf(agent, model);
  if (!efforts.length) return null;
  // A level set in the harness's config applies to every model.
  const fallback = agent?.defaultEffort ?? agent?.models.find((m) => m.id === model)?.defaultEffort;
  return (
    <select className="model-select mono" aria-label={t('思考强度')} title={t('思考强度')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{fallback ? t('默认（{model}）', { model: fallback }) : t('默认强度')}</option>
      {value && !efforts.includes(value) && <option value={value}>{value}</option>}
      {efforts.map((level) => (
        <option key={level} value={level}>{level}</option>
      ))}
    </select>
  );
}

/** Lists what the harness reports. A model set elsewhere is kept as an option, even if it isn't listed. */
export function ModelSelect({ agent, value, onChange }: { agent?: AgentStatus; value: string; onChange(model: string): void }) {
  const models = agent?.models ?? [];
  return (
    <select className="model-select mono" aria-label={t('模型')} title={t('模型')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{agent?.defaultModel ? t('默认（{model}）', { model: agent.defaultModel }) : t('默认模型')}</option>
      {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  );
}

export function Thinking({ text }: { text: string }) {
  return (
    <div className="thinking">
      <span className="wave"><i /><i /><i /><i /></span>
      <span className="muted">{text}</span>
    </div>
  );
}

/** The harness is chosen once, when a chat is created. */
export function HarnessPicker({
  installed,
  detecting,
  value,
  onChange,
}: {
  installed?: AgentBackend[];
  detecting: boolean;
  value?: AgentBackend;
  onChange(harness: AgentBackend): void;
}) {
  return (
    <div className="harness-picker">
      <span className="muted small">Harness</span>
      {detecting && <span className="muted small">{t('检测中')}</span>}
      {installed?.map((id) => (
        <button key={id} className={`chip ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>
          {id}
        </button>
      ))}
      {installed?.length === 0 && <span className="over small">{t('没有检测到本地 Harness，请安装 claude、codex、pi 或 dsh。')}</span>}
    </div>
  );
}
