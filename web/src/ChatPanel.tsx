import { ArrowUp, History, MessageSquare, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../src/shared/i18n';
import type { AgentBackend, ChatMessage, ChatSession, ChatSessionMeta, Job } from '../../src/shared/types';
import { agentsStore, api, bumpLibrary, confirmAction, fail, formatDate, jobsStore, loadAgents, settingsStore, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import type { SelectionAsk } from './PdfViewer';

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
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState<{ text: string; page?: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledAsk = useRef<number>(0);
  const messages = sessionId && session?.id === sessionId ? session.messages : [];

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
  }, [messages.length, running?.text, showHistory]);

  const send = async (text: string, selection?: { text: string; page?: number } | null) => {
    if (!text.trim() || running) return;
    setInput('');
    setQuote(null);
    setShowHistory(false);
    const body = { message: text, selection: selection?.text, page: selection?.page };
    try {
      if (sessionId) {
        const res = await api<{ message: ChatMessage }>(`/papers/${paperId}/chats/${sessionId}/messages`, { body });
        setSession((current) => (current ? { ...current, messages: [...current.messages, res.message] } : current));
      } else {
        const res = await api<{ sessionId: string }>(`/papers/${paperId}/chats`, { body: { ...body, harness: draftHarness } });
        setSessionId(res.sessionId);
      }
    } catch (err) {
      setInput(text);
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
              <div className="chips">
                {starters().map((s) => (
                  <button className="chip" key={s} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
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
              {running.text ? <Markdown source={running.text} onCite={onCite} /> : <Thinking label={harness ?? 'AI'} />}
            </div>
          )}
        </div>
      )}

      <div className="chat-input">
        {!sessionId && !showHistory && (
          <div className="harness-picker">
            <span className="muted small">Harness</span>
            {!agents && <span className="muted small">{t('检测中')}</span>}
            {installed?.map((id) => (
              <button key={id} className={`chip ${draftHarness === id ? 'on' : ''}`} onClick={() => setPickedHarness(id)}>{id}</button>
            ))}
            {installed?.length === 0 && <span className="over small">{t('没有检测到本地 Harness，请安装 claude、codex 或 pi。')}</span>}
          </div>
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

export function Thinking({ label }: { label: string }) {
  return (
    <div className="thinking">
      <span className="wave"><i /><i /><i /><i /></span>
      <span className="muted">{t('{agent} 正在阅读论文', { agent: label })}</span>
    </div>
  );
}
