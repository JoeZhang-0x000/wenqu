import { MessageSquarePlus, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { latestSuggestions, visibleRepoReply } from '../../src/shared/assistant';
import { t } from '../../src/shared/i18n';
import type { AssistantSession, Job } from '../../src/shared/types';
import { Actions } from './Assistant';
import { Thinking } from './ChatPanel';
import { api, bumpLibrary, createStore, fail, jobsStore, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import { MessageChips } from './ui';

const SAVED_KEY = 'wenqu-agent-search';

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

export function AgentSearchResult() {
  const id = useStore(agentSearchStore);
  return id ? <Result key={id} sessionId={id} /> : null;
}

function Result({ sessionId }: { sessionId: string }) {
  const { data: session, error, setData: setSession } = useFetch<AssistantSession>(`/assistant/sessions/${sessionId}`);
  const jobs = useStore(jobsStore);
  const running: Job | undefined = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'assistant' && j.status === 'running' && j.targetId === sessionId),
    [jobs, sessionId],
  );
  const [keeping, setKeeping] = useState(false);
  const [answered, setAnswered] = useState<string>();
  const messages = session?.messages ?? [];
  const suggestions = latestSuggestions(messages, Boolean(running) || answered === messages.at(-1)?.at);
  const streamed = running ? visibleRepoReply(running.text) : '';

  // A search kept from another tab, or cleared out as stale, has nothing left to show here.
  useEffect(() => {
    if (error || (session && !session.temporary)) show(null);
  }, [error, session?.temporary]);

  const followUp = async (text: string) => {
    if (running) return;
    setAnswered(messages.at(-1)?.at);
    try {
      await api(`/assistant/sessions/${sessionId}/messages`, { body: { message: text } });
      bumpLibrary();
    } catch (err) {
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

  // The first message is the query, which is still in the search bar.
  const shown = messages.slice(1);

  return (
    <section className="agent-result" aria-label={t('Agent 搜索结果')} aria-busy={Boolean(running)}>
      <header className="agent-result-head">
        <Sparkles size={14} className="agent-result-mark" />
        <span className="agent-result-query ellipsis" title={messages[0]?.content}>{messages[0]?.content ?? t('Agent 搜索')}</span>
        {session && <span className="agent-pill mono" title={t('使用默认的 Agent 后端')}>{session.harness}</span>}
        <div className="spacer" />
        <button className="btn small" disabled={!session || keeping} title={t('保存为助手里的会话，接着聊')} onClick={keep}>
          <MessageSquarePlus size={13} />{t('转为对话')}
        </button>
        <button className="icon" title={t('关闭并丢弃')} aria-label={t('关闭并丢弃')} onClick={closeAgentSearch}><X size={15} /></button>
      </header>
      <div className="agent-result-body">
        {shown.map((m, i) =>
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
        <MessageChips className="next-steps" label={t('接下来可以问')} items={suggestions} onPick={(s) => void followUp(s)} />
      </div>
    </section>
  );
}
