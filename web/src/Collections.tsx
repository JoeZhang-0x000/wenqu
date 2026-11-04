import { ArrowLeft, AudioLines, Check, FileText, Pencil, Trash2, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useState } from 'react';
import type { CollectionSummary, PaperSummary } from '../../src/shared/types';
import { BlogPanel } from './BlogPanel';
import { api, bumpLibrary, confirmAction, fail, jobsStore, paperHref, player, playerStore, settingsStore, useFetch, useStore } from './lib';
import { PaperCover } from './Library';
import { PodcastPanel } from './PodcastPanel';
import { TabButton } from './Reader';

export function Collections() {
  const { data } = useFetch<CollectionSummary[]>('/collections');
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="serif">{t('合集')}</h1>
        <span className="muted mono">{data?.length ?? ''}</span>
      </header>
      {data && !data.length && (
        <p className="muted center">
          {t('把几篇论文放在一起，做成“本周论文”或小型综述。')} <a href="#/">{t('去书架开始')}</a>
        </p>
      )}
      <div className="collections">
        {data?.map((c) => (
          <a className="collection-card" key={c.id} href={`#/collection/${c.id}`}>
            <div className="stack">
              {c.papers.slice(0, 3).map((p) => <PaperCover key={p.id} paper={p} />)}
            </div>
            <div className="grow">
              <h3 className="serif">{c.title}</h3>
              <div className="muted small">{t('{count} 篇论文', { count: c.papers.length })}</div>
              <div className="collection-counts">
                {c.podcastCount > 0 && <span><AudioLines size={12} />{c.podcastCount}</span>}
                {c.blogCount > 0 && <span><FileText size={12} />{c.blogCount}</span>}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

type Tab = 'blog' | 'podcast';

export function CollectionView({
  id,
  tab: routeTab,
  item,
  onOpenSettings,
}: {
  id: string;
  tab?: string;
  item?: string;
  onOpenSettings(section?: 'api'): void;
}) {
  const { data: collection, error, setData } = useFetch<CollectionSummary>(`/collections/${id}`);
  const { data: allPapers } = useFetch<PaperSummary[]>('/papers');
  const settings = useStore(settingsStore)!;
  const jobs = useStore(jobsStore);
  const [tab, setTab] = useState<Tab>((routeTab as Tab) || 'podcast');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (routeTab) setTab(routeTab as Tab);
  }, [routeTab, item]);

  if (error) {
    return (
      <div className="page">
        <p className="center">{error}</p>
        <p className="center"><a href="#/collections">{t('返回合集')}</a></p>
      </div>
    );
  }
  if (!collection) return null;

  const backend = settings.agent.backend;
  const agentName = settings.agent.models[backend] ? `${backend} · ${settings.agent.models[backend]}` : backend;
  const busy = (kinds: string[]) => Object.values(jobs).some((j) => j.paperId === id && j.status === 'running' && kinds.includes(j.kind));
  const candidates = (allPapers ?? []).filter((p) => !collection.paperIds.includes(p.id));

  const patch = async (body: { title?: string; paperIds?: string[] }) => {
    try {
      setData(await api<CollectionSummary>(`/collections/${id}`, { method: 'PATCH', body }));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="reader">
      <div className="reader-bar">
        <a className="icon" href="#/collections" title={t('返回合集')}><ArrowLeft size={17} /></a>
        {editing ? (
          <form
            className="title-edit"
            onSubmit={async (e) => {
              e.preventDefault();
              await patch({ title });
              setEditing(false);
            }}
          >
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('合集名称')} />
            <button className="icon" title={t('保存')}><Check size={15} /></button>
            <button type="button" className="icon" title={t('取消')} onClick={() => setEditing(false)}><X size={15} /></button>
          </form>
        ) : (
          <div className="reader-title">
            <span className="serif">{collection.title}</span>
            <button className="icon faint" title={t('修改名称')} onClick={() => { setTitle(collection.title); setEditing(true); }}><Pencil size={13} /></button>
          </div>
        )}
        <div className="spacer" />
        <button
          className="icon danger"
          title={t('删除合集')}
          onClick={async () => {
            if (await confirmAction(t('把这个合集和它生成的内容移到 Vault 回收站？论文本身不受影响。'), t('删除'))) {
              try {
                await api(`/collections/${id}`, { method: 'DELETE' });
                if (playerStore.get().paperId === id) player.close();
                bumpLibrary();
                location.hash = '#/collections';
              } catch (err) {
                fail(err);
              }
            }
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div className="reader-main">
        <div className="collection-main">
          <p className="muted">{t('已经生成的内容不会因为增减论文而改变，新生成的内容才会用到最新的列表。')}</p>
          {collection.papers.map((paper, i) => (
            <div className="member" key={paper.id}>
              <span className="member-n mono">{i + 1}</span>
              <PaperCover paper={paper} />
              <div className="member-body">
                <a className="member-title serif" href={paperHref(paper.id)}>{paper.title}</a>
                <div className="muted small">
                  {paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? t(' 等') : ''}
                  {paper.year ? ` · ${paper.year}` : ''} · {t('{count} 页', { count: paper.pages })}
                </div>
                {paper.textChars < 50 && <div className="over small">{t('没有可提取的文字，生成时会跳过这篇')}</div>}
                {paper.abstract && <div className="member-abstract">{paper.abstract}</div>}
              </div>
              <button
                className="icon"
                title={t('从合集移除')}
                disabled={collection.papers.length <= 2}
                onClick={() => patch({ paperIds: collection.paperIds.filter((p) => p !== paper.id) })}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          {candidates.length > 0 && (
            <select
              className="member-add"
              aria-label={t('添加论文到合集')}
              value=""
              onChange={(e) => e.target.value && patch({ paperIds: [...collection.paperIds, e.target.value] })}
            >
              <option value="">{t('添加论文…')}</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          )}
        </div>
        <aside className="side" style={{ width: 'min(520px, 50vw)' }}>
          <div className="tabs" role="tablist">
            <TabButton<Tab> id="podcast" tab={tab} setTab={setTab} busy={busy(['script', 'synth'])}><AudioLines size={15} />{t('播客')}</TabButton>
            <TabButton<Tab> id="blog" tab={tab} setTab={setTab} busy={busy(['blog'])}><FileText size={15} />{t('博客')}</TabButton>
            <div className="spacer" />
            <button className="agent-pill mono" title={t('更换 Agent 后端')} onClick={() => onOpenSettings()}>{backend}</button>
          </div>
          {tab === 'blog' && (
            <BlogPanel
              paperId={id}
              initialItem={routeTab === 'blog' ? item : undefined}
              agentName={agentName}
              onCite={(page, sourcePaper) => {
                if (sourcePaper) location.hash = paperHref(sourcePaper, undefined, undefined, page);
              }}
            />
          )}
          {tab === 'podcast' && (
            <PodcastPanel
              paperId={id}
              initialItem={routeTab === 'podcast' ? item : undefined}
              agentName={agentName}
              onOpenSettings={() => onOpenSettings('api')}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
