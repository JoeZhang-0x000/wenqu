import { Loader2, Moon, Settings as SettingsIcon, Sun, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, confirmStore, connectEvents, fail, jobsStore, localeStore, refreshSettings, routeStore, settingsStore, toastStore, useStore } from './lib';
import { CollectionView, Collections } from './Collections';
import { importFiles, Library } from './Library';
import { Player } from './Player';
import { Reader } from './Reader';
import { SettingsDialog } from './Settings';
import { Works } from './Works';

export function App() {
  const route = useStore(routeStore);
  const settings = useStore(settingsStore);
  // Subscribing here re-renders the whole tree when the language changes.
  useStore(localeStore);
  const [settingsOpen, setSettingsOpen] = useState<false | { section?: 'api' }>(false);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const dragDepth = useRef(0);

  useEffect(() => {
    refreshSettings().catch((err: Error) => setLoadError(err.message));
    connectEvents();
  }, []);

  // Dropping a PDF anywhere imports it, and keeps the browser from navigating to the file.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void importFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (loadError) return <div className="fatal">{t('无法连接本地服务：{error}', { error: loadError })}</div>;
  if (!settings) return null;

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">
          <span className="brand-mark"><i /><i /><i /><i /></span>
          <span className="serif">Paper2Podcast</span>
        </a>
        <nav className="top-nav">
          <a className={route.page === 'library' ? 'on' : ''} href="#/">{t('书架')}</a>
          <a className={route.page === 'collections' || route.page === 'collection' ? 'on' : ''} href="#/collections">{t('合集')}</a>
          <a className={route.page === 'works' ? 'on' : ''} href="#/works">{t('作品')}</a>
        </nav>
        <div className="spacer" />
        <Activity />
        <ThemeToggle />
        <button className="icon" title={t('设置')} onClick={() => setSettingsOpen({})}>
          <SettingsIcon size={17} />
          {!settings.doubao.hasKey && <span className="dot corner" />}
        </button>
      </header>
      <main className="main">
        {route.page === 'library' && <Library />}
        {route.page === 'works' && <Works />}
        {route.page === 'collections' && <Collections />}
        {route.page === 'paper' && route.id && (
          <Reader
            key={route.id}
            paperId={route.id}
            tab={route.tab}
            item={route.item}
            at={route.at}
            onOpenSettings={(section) => setSettingsOpen({ section })}
          />
        )}
        {route.page === 'collection' && route.id && (
          <CollectionView
            key={route.id}
            id={route.id}
            tab={route.tab}
            item={route.item}
            onOpenSettings={(section) => setSettingsOpen({ section })}
          />
        )}
      </main>
      <Player />
      {settingsOpen && <SettingsDialog initial={settingsOpen.section} onClose={() => setSettingsOpen(false)} />}
      {dragging && (
        <div className="drop-veil">
          <span className="serif">{t('松手，把论文放进书架')}</span>
        </div>
      )}
      <Toasts />
      <Confirm />
    </div>
  );
}

function Activity() {
  const jobs = useStore(jobsStore);
  const running = useMemo(() => Object.values(jobs).filter((j) => j.status === 'running' && j.kind !== 'chat'), [jobs]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!running.length) setOpen(false);
  }, [running.length]);
  if (!running.length) return null;
  return (
    <div className="activity">
      <button className="activity-btn" onClick={() => setOpen(!open)}>
        <Loader2 size={14} className="spin" />
        {t('{count} 个任务', { count: running.length })}
      </button>
      {open && (
        <div className="activity-list">
          {running.map((job) => (
            <div className="activity-item" key={job.id}>
              <div className="grow">
                <div className="activity-label">{job.label}</div>
                {job.progress?.note && <div className="muted small">{job.progress.note}</div>}
              </div>
              <button className="icon" title={t('取消任务')} onClick={() => api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(fail)}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const explicit = document.documentElement.dataset.theme;
    return explicit ? explicit === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  });
  return (
    <button
      className="icon"
      title={dark ? t('切换到浅色') : t('切换到深色')}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('p2p-theme', next);
        } catch {
          /* A convenience only. */
        }
        setDark(!dark);
      }}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

function Toasts() {
  const toasts = useStore(toastStore);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id}>{t.text}</div>
      ))}
    </div>
  );
}

function Confirm() {
  const request = useStore(confirmStore);
  if (!request) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && request.resolve(false)}>
      <div className="confirm" role="alertdialog">
        <p>{request.message}</p>
        <div className="form-actions">
          <button className="btn ghost" onClick={() => request.resolve(false)}>{t('取消')}</button>
          <button className="btn danger" autoFocus onClick={() => request.resolve(true)}>{request.action}</button>
        </div>
      </div>
    </div>
  );
}
