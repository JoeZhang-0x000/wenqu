import { Bot, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../src/shared/i18n';
import type { AssistantSession, Job } from '../../src/shared/types';
import { MessageList } from './Assistant';
import { Thinking } from './ChatPanel';
import { api, bumpLibrary, createStore, fail, jobsStore, useFetch, useStore } from './lib';

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
 * An agent search is an assistant chat with a single question: the same replies, actions and
 * approval cards, without a box to ask more. Continuing it moves it to the Assistant page.
 */
export function AgentSearchView({ sessionId, onQuery }: { sessionId: string; onQuery(query: string): void }) {
  const { data: session, error, setData: setSession } = useFetch<AssistantSession>(`/assistant/sessions/${sessionId}`);
  const jobs = useStore(jobsStore);
  const running: Job | undefined = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'assistant' && j.status === 'running' && j.targetId === sessionId),
    [jobs, sessionId],
  );
  const [keeping, setKeeping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  const waiting = messages.some((m) => m.actions?.some((a) => a.status === 'pending'));
  // An answer still coming in, or a card waiting for the user, is never folded away.
  const folded = tall && !expanded && !running && !waiting;

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
      {tall && !waiting && !running && (
        <button className="overview-more" onClick={() => setExpanded(!expanded)}>
          {folded ? t('展开') : t('收起')}
          {folded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      )}
      <button className="overview-keep" disabled={!session || keeping} title={t('保存为助手里的会话，在那里接着问')} onClick={keep}>
        <Bot size={16} />
        {t('在助手中继续')}
      </button>
    </div>
  );

  return (
    <section className="search-view overview" aria-label={t('AI 概览')} aria-busy={Boolean(running)}>
      <h2 className="search-label">{t('AI 概览')}</h2>
      <div className={`overview-flow ${folded ? 'folded' : ''}`} ref={flowRef} style={folded ? { maxHeight: FOLDED_HEIGHT } : undefined}>
        {/* The question is in the search bar. */}
        <MessageList sessionId={sessionId} messages={messages.slice(1)} running={running} harness={session?.harness} onSession={setSession} />
        {!session && <Thinking text={t('{agent} 正在搜索', { agent: 'AI' })} />}
        {folded && tools}
      </div>
      {!folded && tools}
    </section>
  );
}
