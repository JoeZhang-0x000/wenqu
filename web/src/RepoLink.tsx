import { ExternalLink, GitBranch, Loader2, RefreshCw, Unlink, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../src/shared/i18n';
import { parseRepoUrl, repoLabel, repoUrl, shortSha } from '../../src/shared/repo';
import type { PaperSummary, RepoCandidate, RepoState } from '../../src/shared/types';
import { api, fail, jobsStore, useStore } from './lib';
import { Switch } from './ui';

/** The one thing worth saying about why a repository is listed. None of these is proof. */
function reason(candidate: RepoCandidate): string {
  const parts = [t('第 {page} 页', { page: candidate.page })];
  if (candidate.hints.includes('references')) parts.push(t('只出现在参考文献'));
  else if (candidate.hints.includes('name')) parts.push(t('名称和论文标题相同'));
  else if (candidate.hints.includes('context')) parts.push(t('论文在这里提到了代码'));
  else if (candidate.hints.includes('dependency')) parts.push(t('可能是依赖或基线'));
  return parts.join(' · ');
}

/** Lives in the chat bar. Candidates only come from what's on disk, and only a click here fetches anything. */
export function RepoLink({
  paperId,
  state,
  busy,
  onLinkChange,
}: {
  paperId: string;
  state?: RepoState;
  /** A chat is answering, so the link can't change under it. */
  busy: boolean;
  onLinkChange(link: RepoState['link']): void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const jobs = useStore(jobsStore);
  const latest = useMemo(
    () => Object.values(jobs).filter((j) => j.kind === 'repo' && j.paperId === paperId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1),
    [jobs, paperId],
  );
  const running = latest?.status === 'running' ? latest : undefined;
  const failure = latest?.status === 'failed' && latest.id !== dismissed ? latest.error : undefined;
  const link = state?.link;
  const others = (state?.candidates ?? []).filter((c) => !link || repoLabel(c).toLowerCase() !== repoLabel(link).toLowerCase());
  const likely = others.filter((c) => c.likely);
  const rest = others.filter((c) => !c.likely);
  const pasted = url.trim();
  const pastedValid = Boolean(parseRepoUrl(pasted));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (failure) setOpen(true);
  }, [failure]);

  // A failed address stays in the field, since it may only need a small fix.
  useEffect(() => {
    if (latest?.status === 'done') setUrl('');
  }, [latest?.id, latest?.status]);

  const linkTo = async (target: string) => {
    if (latest) setDismissed(latest.id);
    try {
      await api(`/papers/${paperId}/repo`, { body: { url: target } });
    } catch (err) {
      fail(err);
    }
  };

  const toggle = async (enabled: boolean) => {
    try {
      onLinkChange((await api<PaperSummary>(`/papers/${paperId}/repo`, { method: 'PATCH', body: { enabled } })).repo);
    } catch (err) {
      fail(err);
    }
  };

  const unlink = async () => {
    try {
      await api(`/papers/${paperId}/repo`, { method: 'DELETE' });
      onLinkChange(undefined);
    } catch (err) {
      fail(err);
    }
  };

  const row = (candidate: RepoCandidate) => (
    <li className="repo-row" key={repoLabel(candidate)}>
      <div className="grow">
        <div className="repo-name mono" title={candidate.url}>{repoLabel(candidate)}</div>
        <div className="muted small">{reason(candidate)}</div>
      </div>
      <button className="btn small" disabled={Boolean(running) || busy} onClick={() => linkTo(candidate.url)}>{t('关联')}</button>
    </li>
  );

  const buttonTitle = link ? t('已关联代码仓库') : t('关联代码仓库');
  const count = likely.length || rest.length;

  return (
    <div className="repo-link" ref={rootRef}>
      <button
        className={`repo-pill ${link ? 'linked' : ''} ${link && !link.enabled ? 'off' : ''} ${open ? 'open' : ''}`}
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {running ? <Loader2 size={13} className="spin" /> : <GitBranch size={13} />}
        {link ? (
          <span className="repo-pill-text mono">{repoLabel(link)} @ {shortSha(link.sha)}</span>
        ) : (
          count > 0 && <span className={`repo-count mono ${likely.length ? 'likely' : ''}`}>{count}</span>
        )}
      </button>
      {open && (
        <div className="repo-pop" role="dialog" aria-label={buttonTitle}>
          {link && (
            <section className="repo-current">
              <div className="repo-row">
                <div className="grow">
                  <div className="repo-name mono" title={repoUrl(link)}>{repoLabel(link)} @ {shortSha(link.sha)}</div>
                </div>
                <a className="icon" href={`${repoUrl(link)}/tree/${link.sha}`} target="_blank" rel="noopener noreferrer" title={t('在 GitHub 上打开')}><ExternalLink size={14} /></a>
                <button className="icon" title={t('拉取最新提交')} disabled={Boolean(running) || busy} onClick={() => linkTo(repoUrl(link))}><RefreshCw size={14} /></button>
                <button className="icon danger" title={t('取消关联')} disabled={Boolean(running) || busy} onClick={unlink}><Unlink size={14} /></button>
              </div>
              <Switch checked={link.enabled} label={t('让问答读取这个仓库')} onChange={toggle} />
            </section>
          )}
          {running && (
            <div className="repo-status">
              <Loader2 size={13} className="spin" />
              <span className="grow small">{running.progress?.note ?? t('正在关联')}{running.progress?.total ? ` ${running.progress.done}%` : ''}</span>
              <button className="icon" title={t('取消任务')} onClick={() => api(`/jobs/${running.id}/cancel`, { method: 'POST' }).catch(fail)}><X size={14} /></button>
            </div>
          )}
          {failure && (
            <div className="repo-status bad" role="alert">
              <span className="grow small">{failure}</span>
              <button className="icon" title={t('知道了')} onClick={() => setDismissed(latest?.id)}><X size={14} /></button>
            </div>
          )}
          {likely.length > 0 && (
            <section>
              <h4>{t('可能是这篇论文的代码')}</h4>
              <ul>{likely.map(row)}</ul>
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <h4>{t('论文提到的其他仓库')}</h4>
              <ul>{rest.map(row)}</ul>
            </section>
          )}
          {!link && state && !others.length && <p className="muted small">{t('没有在论文里发现仓库链接')}</p>}
          <form
            className="repo-paste"
            onSubmit={(e) => {
              e.preventDefault();
              if (pastedValid) void linkTo(pasted);
            }}
          >
            <input
              className="mono"
              placeholder="https://github.com/owner/repo"
              aria-label={t('关联代码仓库')}
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn small" type="submit" disabled={!pastedValid || Boolean(running) || busy}>{t('关联')}</button>
          </form>
          {pasted && !pastedValid && <p className="over small">{t('请输入这样的地址：https://github.com/<owner>/<repo>')}</p>}
          <p className="muted small repo-hint">{t('关联后，问答会把仓库内容发送给所选的 Agent 服务。只有点击关联才会访问网络。')}</p>
        </div>
      )}
    </div>
  );
}
