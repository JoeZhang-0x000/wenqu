import { ArrowUp, Square, Trash2, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Job } from '../../src/shared/types';
import { api, confirmAction, fail, jobsStore, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import type { SelectionAsk } from './PdfViewer';

const starters = () => [t('一句话总结这篇论文'), t('核心贡献是什么？'), t('方法的关键步骤是什么？'), t('有哪些局限和未解决的问题？')];

export function ChatPanel({
  paperId,
  ask,
  onCite,
  agentName,
}: {
  paperId: string;
  ask: (SelectionAsk & { nonce: number }) | null;
  onCite(page: number): void;
  agentName: string;
}) {
  const { data, setData } = useFetch<ChatMessage[]>(`/papers/${paperId}/chat`);
  const jobs = useStore(jobsStore);
  const running: Job | undefined = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'chat' && j.paperId === paperId && j.status === 'running'),
    [jobs, paperId],
  );
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState<{ text: string; page?: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledAsk = useRef<number>(0);
  const messages = data ?? [];

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, running?.text]);

  const send = async (text: string, selection?: { text: string; page?: number } | null) => {
    if (!text.trim() || running) return;
    setInput('');
    setQuote(null);
    try {
      const res = await api<{ message: ChatMessage }>(`/papers/${paperId}/chat`, {
        body: { message: text, selection: selection?.text, page: selection?.page },
      });
      setData((current) => [...(current ?? []), res.message]);
    } catch (err) {
      setInput(text);
      fail(err);
    }
  };

  useEffect(() => {
    if (!ask || handledAsk.current === ask.nonce) return;
    handledAsk.current = ask.nonce;
    const selection = { text: ask.selection, page: ask.page };
    if (ask.prompt) {
      void send(ask.prompt, selection);
    } else {
      setQuote(selection);
      inputRef.current?.focus();
    }
  }, [ask]);

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {!messages.length && !running && (
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
            {running.text ? <Markdown source={running.text} onCite={onCite} /> : <Thinking label={agentName} />}
          </div>
        )}
      </div>
      <div className="chat-input">
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
            placeholder={quote ? t('针对这段文字提问') : t('问问 {agent}', { agent: agentName })}
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
            {messages.length > 0 && (
              <button
                className="icon"
                title={t('清空对话')}
                onClick={async () => {
                  if (await confirmAction(t('清空这篇论文的对话记录？'), t('清空'))) {
                    await api(`/papers/${paperId}/chat`, { method: 'DELETE' }).catch(fail);
                    setData([]);
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
            <div className="spacer" />
            {running ? (
              <button className="send" title={t('停止')} onClick={() => api(`/jobs/${running.id}/cancel`, { method: 'POST' }).catch(fail)}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button className="send" title={t('发送')} disabled={!input.trim()} onClick={() => send(input, quote)}>
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
