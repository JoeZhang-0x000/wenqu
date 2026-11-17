import { ArrowUp, Bot, ChevronDown, ChevronUp, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { latestSuggestions, visibleRepoReply } from '../../src/shared/assistant';
import { t } from '../../src/shared/i18n';
import type { AssistantSession, Job } from '../../src/shared/types';
import { Actions } from './Assistant';
import { Thinking } from './ChatPanel';
import { api, bumpLibrary, createStore, fail, jobsStore, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import { MessageChips } from './ui';

const SAVED_KEY = 'wenqu-agent-search';
/** Taller than this, a finished overview is folded until the user asks for the rest. */
const FOLDED_HEIGHT = 300;

function saved(): string | null {
  try {
    return sessionStorage.getItem(SAVED_KEY);
  } catch {
    return null;
  }
}

/** The search being shown, kept across pages and reloads of this tab, so leaving the library doesn't lose it. */
export const agentSearchStore = createStore<string | null>(saved());

function show(id: string | null) {
  agentSearchStore.set(id);
  try {
    if (id) sessionStorage.setItem(SAVED_KEY, id);
    else sessionStorage.removeItem(SAVED_KEY);
  } catch {
    /* It just won't survive a reload. */
  }
}

/** Throws away a search nobody kept. The server stops it first if it's still answering. */
function discard(id: string) {
  api(`/assistant/sessions/${id}`, { method: 'DELETE' }).catch(() => {
    /* Already gone, or kept elsewhere. Anything left over is cleared out after a day. */
  });
}

/** A new search replaces the one shown, on the default harness with its model and thinking level. */
export async function startAgentSearch(query: string): Promise<void> {
  const previous = agentSearchStore.get();
  const { sessionId } = await api<{ sessionId: string }>('/assistant/sessions', { body: { message: query, temporary: true } });
  show(sessionId);
  if (previous) discard(previous);
}

export function closeAgentSearch() {
  const id = agentSearchStore.get();
  show(null);
  if (id) discard(id);
}

/**
 * The page an agent search turns the library into: an overview that reads like a search result,
 * the conversation that follows from it, and the papers it found.
 */
export function AgentSearchView({
  sessionId,
  onQuery,
  renderResults,
}: {
  sessionId: string;
  /** The question this search was asked with, for the search bar to show. */
  onQuery(query: string): void;
  renderResults(session: AssistantSession | undefined, running: boolean): ReactNode;
}) {
  const { data: session, error, setData: setSession } = useFetch<AssistantSession>(`/assistant/sessions/${sessionId}`);
  const jobs = useStore(jobsStore);
  const running: Job | undefined = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'assistant' && j.status === 'running' && j.targetId === sessionId),
    [jobs, sessionId],
  );
  const [keeping, setKeeping] = useState(false);
  const [answered, setAnswered] = useState<string>();
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  const suggestions = latestSuggestions(messages, Boolean(running) || answered === messages.at(-1)?.at);
  const streamed = running ? visibleRepoReply(running.text) : '';
  // The first message is the question, which the search bar shows.
  const flow = messages.slice(1);
  const followedUp = flow.some((m) => m.role === 'user');
  const waiting = flow.some((m) => m.actions?.some((a) => a.status === 'pending'));
  // A conversation, an answer still coming in or a card waiting for the user is never folded away.
  const folded = tall && !expanded && !running && !followedUp && !waiting;

  // A search kept from another tab, or cleared out as stale, has nothing left to show here.
  useEffect(() => {
    if (error || (session && !session.temporary)) show(null);
  }, [error, session?.temporary]);

  useEffect(() => {
    if (messages[0]) onQuery(messages[0].content);
  }, [messages[0]?.content]);

  useLayoutEffect(() => {
    const el = flowRef.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLDED_HEIGHT + 80);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [session]);

  const followUp = async (text: string, fromChip = false) => {
    if (!text.trim() || running) return;
    if (!fromChip) setInput('');
    setAnswered(messages.at(-1)?.at);
    setExpanded(true);
    try {
      await api(`/assistant/sessions/${sessionId}/messages`, { body: { message: text } });
      bumpLibrary();
    } catch (err) {
      if (!fromChip) setInput(text);
      setAnswered(undefined);
      fail(err);
    }
  };

  const keep = async () => {
    setKeeping(true);
    try {
      await api(`/assistant/sessions/${sessionId}/keep`, { method: 'POST' });
      show(null);
      bumpLibrary();
      location.hash = `#/assistant/${sessionId}`;
    } catch (err) {
      fail(err);
      setKeeping(false);
    }
  };

  const tools = (
    <div className="overview-tools">
      {tall && !followedUp && !waiting && !running && (
        <button className="overview-more" onClick={() => setExpanded(!expanded)}>
          {folded ? t('展开') : t('收起')}
          {folded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      )}
      <button className="overview-keep" disabled={!session || keeping} data-tip={t('在助手中继续')} aria-label={t('在助手中继续')} onClick={keep}>
        <Bot size={17} />
      </button>
    </div>
  );

  return (
    <div className="search-view">
      <section className="overview" aria-label={t('AI 概览')} aria-busy={Boolean(running)}>
        <h2 className="search-label">{t('AI 概览')}</h2>
        <div className={`overview-flow ${folded ? 'folded' : ''}`} ref={flowRef} style={folded ? { maxHeight: FOLDED_HEIGHT } : undefined}>
          {flow.map((m, i) =>
            m.role === 'user' ? (
              <div className="msg user" key={i}>{m.content}</div>
            ) : (
              <div className={`msg ai ${m.error ? 'err' : ''}`} key={i}>
                {m.error ? <p>{m.content}</p> : m.content && <Markdown source={m.content} repo={m.repo} />}
                {m.actions && <Actions sessionId={sessionId} actions={m.actions} locked={Boolean(running)} onSession={setSession} />}
              </div>
            ),
          )}
          {(running || !session) && (
            <div className="msg ai">
              {streamed ? <Markdown source={streamed} /> : <Thinking text={running?.progress?.note ?? t('{agent} 正在搜索', { agent: session?.harness ?? 'AI' })} />}
            </div>
          )}
          {folded && tools}
        </div>
        {!folded && tools}
        <MessageChips className="next-steps" label={t('接下来可以问')} items={suggestions} onPick={(s) => void followUp(s, true)} />
        <form
          className="followup"
          onSubmit={(e) => {
            e.preventDefault();
            void followUp(input);
          }}
        >
          <input aria-label={t('追问')} placeholder={t('追问')} value={input} onChange={(e) => setInput(e.target.value)} />
          {running ? (
            <button type="button" className="send" title={t('停止')} onClick={() => api(`/jobs/${running.id}/cancel`, { method: 'POST' }).catch(fail)}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send" title={t('发送')} disabled={!input.trim() || !session}>
              <ArrowUp size={16} />
            </button>
          )}
        </form>
      </section>
      {renderResults(session, Boolean(running))}
    </div>
  );
}
