import { AudioLines, FileText, Pause, Play } from 'lucide-react';
import { t, tx } from '../../src/shared/i18n';
import { useMemo, useState } from 'react';
import { BLOG_STYLES, PODCAST_STYLES, type OutputEntry, type Podcast } from '../../src/shared/types';
import { api, fail, formatDate, formatTime, ownerHref, player, playerStore, useFetch, useStore } from './lib';

type Kind = 'all' | 'podcast' | 'blog';

export function Works() {
  const { data } = useFetch<OutputEntry[]>('/outputs');
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');
  const state = useStore(playerStore);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (o) => (kind === 'all' || o.kind === kind) && (!q || `${o.title} ${o.paperTitle}`.toLowerCase().includes(q)),
    );
  }, [data, kind, query]);

  const label = (o: OutputEntry) => {
    const preset = (o.kind === 'blog' ? BLOG_STYLES : PODCAST_STYLES).find((s) => s.id === o.style)?.label;
    if (preset) return tx(preset);
    return o.style === 'custom' ? t('自定义') : o.kind === 'podcast' ? t('豆包直出') : '';
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="serif">{t('作品')}</h1>
        <span className="muted mono">{data?.length ?? ''}</span>
        <div className="spacer" />
        <div className="search">
          <input placeholder={t('搜索作品或论文')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </header>
      <div className="chips filters">
        {(['all', 'podcast', 'blog'] as Kind[]).map((k) => (
          <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            {{ all: t('全部'), podcast: t('播客'), blog: t('博客') }[k]}
          </button>
        ))}
      </div>
      {data && !data.length && <p className="muted center">{t('还没有生成内容。打开一篇论文，在右侧开始生成。')}</p>}
      <div className="works">
        {visible.map((o) => {
          const isCurrent = state.podcast?.id === o.id;
          return (
            <div className="work" key={`${o.kind}-${o.id}`}>
              {o.kind === 'podcast' && o.status === 'ready' ? (
                <button
                  className="work-play"
                  title={isCurrent && state.playing ? t('暂停') : t('播放')}
                  onClick={async () => {
                    if (isCurrent) return player.toggle();
                    try {
                      player.play(o.paperId, await api<Podcast>(`/papers/${o.paperId}/podcasts/${o.id}`));
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  {isCurrent && state.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                </button>
              ) : (
                <span className="work-icon">{o.kind === 'podcast' ? <AudioLines size={16} /> : <FileText size={16} />}</span>
              )}
              <a className="work-main" href={ownerHref(o.paperId, o.kind, o.id)}>
                <span className="work-title serif">{o.title}</span>
                <span className="work-paper muted">{o.paperTitle}</span>
              </a>
              <span className="work-tag">{label(o)}</span>
              {o.kind === 'podcast' && o.status !== 'ready' && (
                <span className={`status ${o.status}`}>{{ draft: t('待合成'), synthesizing: t('合成中'), failed: t('失败') }[o.status as 'draft']}</span>
              )}
              <span className="muted mono small work-size">
                {o.kind === 'podcast' ? (o.duration ? formatTime(o.duration) : '') : t('{count} 字符', { count: (o.chars ?? 0).toLocaleString() })}
              </span>
              <span className="muted mono small work-date">{formatDate(o.createdAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
