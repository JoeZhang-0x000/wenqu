import { ArrowLeft, AudioLines, BookOpen, Check, ExternalLink, FileText, FolderOpen, Pencil, Trash2, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import type { PaperSummary } from '../../src/shared/types';
import { BlogPanel } from './BlogPanel';
import { ChatDock, type ChatDockHandle } from './ChatDock';
import { ChatPanel } from './ChatPanel';
import { api, bumpLibrary, confirmAction, fail, jobsStore, paperHref, player, playerStore, settingsStore, toast, useFetch, useStore } from './lib';
import { PdfViewer, type PdfHandle, type SelectionAsk } from './PdfViewer';
import { PodcastPanel } from './PodcastPanel';

type View = 'paper' | 'blog' | 'podcast';

const toView = (tab?: string): View => (tab === 'blog' || tab === 'podcast' ? tab : 'paper');

export function Reader({
  paperId,
  tab: routeTab,
  item,
  at,
  onOpenSettings,
}: {
  paperId: string;
  tab?: string;
  item?: string;
  at?: number;
  onOpenSettings(section?: 'api'): void;
}) {
  const { data: paper, error, setData } = useFetch<PaperSummary>(`/papers/${paperId}`);
  const settings = useStore(settingsStore)!;
  const jobs = useStore(jobsStore);
  const [view, setViewState] = useState<View>(toView(routeTab));
  const [ask, setAsk] = useState<(SelectionAsk & { nonce: number }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const pdfRef = useRef<PdfHandle>(null);
  const dockRef = useRef<ChatDockHandle>(null);
  const nonce = useRef(0);

  useEffect(() => {
    if (routeTab) setViewState(toView(routeTab));
  }, [routeTab, item]);

  // Keeps the view across a reload, without adding to the browser history.
  const setView = (next: View) => {
    setViewState(next);
    history.replaceState(null, '', paperHref(paperId, next === 'paper' ? undefined : next));
  };

  useEffect(() => {
    if (at) pdfRef.current?.goToPage(at);
  }, [at]);

  if (error) {
    return (
      <div className="page">
        <p className="center">{error}</p>
        <p className="center"><a href="#/">{t('返回书架')}</a></p>
      </div>
    );
  }
  if (!paper) return null;

  const backend = settings.agent.backend;
  const agentName = settings.agent.models[backend] ? `${backend} · ${settings.agent.models[backend]}` : backend;
  const goToPage = (page: number) => {
    setView('paper');
    // The PDF has to be visible before it can scroll.
    requestAnimationFrame(() => pdfRef.current?.goToPage(page));
  };
  const noText = paper.textChars < 50;
  const busy = (kind: string[]) => Object.values(jobs).some((j) => j.paperId === paperId && j.status === 'running' && kind.includes(j.kind));

  return (
    <div className="reader">
      <div className="reader-bar">
        <a className="icon" href="#/" title={t('返回书架')}><ArrowLeft size={17} /></a>
        <div className="view-tabs" role="tablist">
          <TabButton<View> id="paper" tab={view} setTab={setView} busy={false}><BookOpen size={14} />{t('论文')}</TabButton>
          <TabButton<View> id="blog" tab={view} setTab={setView} busy={busy(['blog'])}><FileText size={14} />{t('博客')}</TabButton>
          <TabButton<View> id="podcast" tab={view} setTab={setView} busy={busy(['script', 'synth'])}><AudioLines size={14} />{t('播客')}</TabButton>
        </div>
        {editing ? (
          <form
            className="title-edit"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setData(await api<PaperSummary>(`/papers/${paperId}`, { method: 'PATCH', body: { title } }));
                setEditing(false);
              } catch (err) {
                fail(err);
              }
            }}
          >
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('论文标题')} />
            <button className="icon" title={t('保存')}><Check size={15} /></button>
            <button type="button" className="icon" title={t('取消')} onClick={() => setEditing(false)}><X size={15} /></button>
          </form>
        ) : (
          <div className="reader-title">
            <span className="serif" title={paper.title}>{paper.title}</span>
            <button className="icon faint" title={t('修改标题')} onClick={() => { setTitle(paper.title); setEditing(true); }}><Pencil size={13} /></button>
          </div>
        )}
        <span className="muted small reader-authors">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? t(' 等') : ''}</span>
        <div className="spacer" />
        {paper.arxivId && (
          <a className="source-link mono" href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer" title={t('在 arXiv 上打开')}>
            arXiv:{paper.arxivId}<ExternalLink size={11} />
          </a>
        )}
        <button className="icon" title={t('在文件管理器中显示')} onClick={() => api(`/papers/${paperId}/reveal`, { method: 'POST' }).catch(fail)}>
          <FolderOpen size={16} />
        </button>
        <button
          className="icon danger"
          title={t('删除论文')}
          onClick={async () => {
            if (await confirmAction(t('把这篇论文和它生成的所有内容移到 Vault 回收站？'), t('删除'))) {
              try {
                await api(`/papers/${paperId}`, { method: 'DELETE' });
                if (playerStore.get().paperId === paperId) player.close();
                bumpLibrary();
                toast(t('已移到回收站'));
                location.hash = '#/';
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
        {/* The PDF stays mounted, so the reading position survives switching views. */}
        <PdfViewer
          ref={pdfRef}
          url={`/api/papers/${paperId}/pdf`}
          initialPage={at}
          hidden={view !== 'paper'}
          onAsk={(next) => {
            dockRef.current?.reveal();
            setAsk({ ...next, nonce: ++nonce.current });
          }}
        />
        {view === 'blog' && (
          <div className="main-view">
            <BlogPanel paperId={paperId} initialItem={routeTab === 'blog' ? item : undefined} onCite={goToPage} agentName={agentName} />
          </div>
        )}
        {view === 'podcast' && (
          <div className="main-view">
            <PodcastPanel
              paperId={paperId}
              initialItem={routeTab === 'podcast' ? item : undefined}
              agentName={agentName}
              onOpenSettings={() => onOpenSettings('api')}
            />
          </div>
        )}
        <ChatDock
          ref={dockRef}
          busy={busy(['chat'])}
          head={<button className="agent-pill mono" title={t('更换 Agent 后端')} onClick={() => onOpenSettings()}>{backend}</button>}
          notice={noText && <div className="notice err tight">{t('这份 PDF 没有可提取的文字（可能是扫描件），AI 功能暂时无法使用。')}</div>}
        >
          <ChatPanel paperId={paperId} ask={ask} onCite={goToPage} agentName={agentName} />
        </ChatDock>
      </div>
    </div>
  );
}

export function TabButton<T extends string>({
  id,
  tab,
  setTab,
  busy,
  children,
}: {
  id: T;
  tab: T;
  setTab(t: T): void;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <button role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
      {children}
      {busy && <span className="dot live" />}
    </button>
  );
}
