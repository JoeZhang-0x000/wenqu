import { ArrowLeft, AudioLines, Check, ExternalLink, FileText, FolderOpen, MessagesSquare, Pencil, Trash2, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import type { PaperSummary } from '../../src/shared/types';
import { BlogPanel } from './BlogPanel';
import { ChatPanel } from './ChatPanel';
import { api, bumpLibrary, confirmAction, fail, jobsStore, player, playerStore, settingsStore, toast, useFetch, useStore } from './lib';
import { PdfViewer, type PdfHandle, type SelectionAsk } from './PdfViewer';
import { PodcastPanel } from './PodcastPanel';

type Tab = 'chat' | 'blog' | 'podcast';

const readWidth = () => {
  try {
    return Number(localStorage.getItem('p2p-panel-width')) || 460;
  } catch {
    return 460;
  }
};

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
  const [tab, setTab] = useState<Tab>((routeTab as Tab) || 'chat');
  const [ask, setAsk] = useState<(SelectionAsk & { nonce: number }) | null>(null);
  const [width, setWidth] = useState(readWidth);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const pdfRef = useRef<PdfHandle>(null);
  const nonce = useRef(0);

  useEffect(() => {
    if (routeTab) setTab(routeTab as Tab);
  }, [routeTab, item]);

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
  const goToPage = (page: number) => pdfRef.current?.goToPage(page);
  const noText = paper.textChars < 50;
  const busy = (kind: string[]) => Object.values(jobs).some((j) => j.paperId === paperId && j.status === 'running' && kind.includes(j.kind));

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      latest = Math.min(Math.max(340, startWidth + startX - ev.clientX), window.innerWidth - 360);
      setWidth(latest);
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('p2p-panel-width', String(latest));
      } catch {
        /* A convenience only. */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="reader">
      <div className="reader-bar">
        <a className="icon" href="#/" title={t('返回书架')}><ArrowLeft size={17} /></a>
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
        <PdfViewer
          ref={pdfRef}
          url={`/api/papers/${paperId}/pdf`}
          initialPage={at}
          onAsk={(next) => {
            setTab('chat');
            setAsk({ ...next, nonce: ++nonce.current });
          }}
        />
        <div className="splitter" onPointerDown={startResize} />
        <aside className="side" style={{ width }}>
          <div className="tabs" role="tablist">
            <TabButton<Tab> id="chat" tab={tab} setTab={setTab} busy={busy(['chat'])}><MessagesSquare size={15} />{t('问答')}</TabButton>
            <TabButton<Tab> id="blog" tab={tab} setTab={setTab} busy={busy(['blog'])}><FileText size={15} />{t('博客')}</TabButton>
            <TabButton<Tab> id="podcast" tab={tab} setTab={setTab} busy={busy(['script', 'synth'])}><AudioLines size={15} />{t('播客')}</TabButton>
            <div className="spacer" />
            <button className="agent-pill mono" title={t('更换 Agent 后端')} onClick={() => onOpenSettings()}>{backend}</button>
          </div>
          {noText && <div className="notice err tight">{t('这份 PDF 没有可提取的文字（可能是扫描件），AI 功能暂时无法使用。')}</div>}
          {tab === 'chat' && <ChatPanel paperId={paperId} ask={ask} onCite={goToPage} agentName={agentName} />}
          {tab === 'blog' && <BlogPanel paperId={paperId} initialItem={routeTab === 'blog' ? item : undefined} onCite={goToPage} agentName={agentName} />}
          {tab === 'podcast' && (
            <PodcastPanel
              paperId={paperId}
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
