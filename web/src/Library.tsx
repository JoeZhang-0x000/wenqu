import { AudioLines, Check, FileText, Layers, Link2, Plus, Search, Upload } from 'lucide-react';
import { getLocale, t } from '../../src/shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaperSummary } from '../../src/shared/types';
import { openAddPaper } from './AddPaper';
import { api, fail, paperHref, useFetch } from './lib';
import { renderThumb } from './pdf';

const VERSE = '问渠哪得清如许？为有源头活水来。';

function Motto() {
  return (
    <figure className="motto">
      <blockquote className="serif" lang="zh-CN">{VERSE}</blockquote>
      {getLocale() !== 'zh' && <p className="motto-gloss">How can the water run so clear? Because fresh water keeps flowing from its source.</p>}
      <figcaption>{t('朱熹《观书有感》')}</figcaption>
    </figure>
  );
}

type Filter = 'all' | 'blog' | 'podcast' | 'none';
const filters = (): { id: Filter; label: string }[] => [
  { id: 'all', label: t('全部') },
  { id: 'podcast', label: t('有播客') },
  { id: 'blog', label: t('有博客') },
  { id: 'none', label: t('未生成') },
];

export function Library() {
  const { data: papers } = useFetch<PaperSummary[]>('/papers');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string[] | null>(null);
  const [collectionTitle, setCollectionTitle] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (papers ?? []).filter((p) => {
      if (filter === 'blog' && !p.blogCount) return false;
      if (filter === 'podcast' && !p.podcastCount) return false;
      if (filter === 'none' && (p.blogCount || p.podcastCount)) return false;
      return !q || `${p.title} ${p.authors.join(' ')} ${p.abstract ?? ''}`.toLowerCase().includes(q);
    });
  }, [papers, query, filter]);

  if (papers && !papers.length) {
    return (
      <div className="page">
        <Motto />
        <button className="empty-drop" onClick={() => openAddPaper('file')}>
          <Upload size={26} strokeWidth={1.5} />
          <span className="serif">{t('把第一篇论文拖进来')}</span>
          <span className="muted">{t('或者点击选择 PDF。也可以在终端运行')} <code>wenqu add paper.pdf</code></span>
        </button>
        <div className="empty-arxiv">
          <button className="btn" onClick={() => openAddPaper('link')}><Link2 size={14} />{t('用 arXiv 链接添加')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <Motto />
      <header className="page-head">
        <h1 className="serif">{t('书架')}</h1>
        <span className="muted mono">{papers?.length ?? ''}</span>
        <div className="spacer" />
        <div className="search">
          <Search size={14} />
          <input placeholder={t('搜索标题、作者、摘要')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button
          className={`btn ${selected ? 'on' : ''}`}
          disabled={(papers?.length ?? 0) < 2}
          title={t('选择几篇论文，做成一个合集')}
          onClick={() => {
            setSelected(selected ? null : []);
            const now = new Date();
            setCollectionTitle(t('本周论文 {date}', { date: `${now.getMonth() + 1}/${now.getDate()}` }));
          }}
        >
          <Layers size={14} />{t('做合集')}
        </button>
        <button className="btn primary" onClick={() => openAddPaper()}><Plus size={15} />{t('添加论文')}</button>
      </header>
      <div className="chips filters">
        {filters().map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <div className="shelf">
        {visible.map((p) => (
          <PaperCard
            key={p.id}
            paper={p}
            selected={selected ? selected.includes(p.id) : undefined}
            onToggle={() => setSelected(selected?.includes(p.id) ? selected.filter((id) => id !== p.id) : [...(selected ?? []), p.id])}
          />
        ))}
      </div>
      {papers && !visible.length && <p className="muted center">{t('没有符合条件的论文。')}</p>}
      {selected && (
        <div className="select-bar">
          {t('{count} 篇', { count: selected.length })}
          <input aria-label={t('合集名称')} value={collectionTitle} onChange={(e) => setCollectionTitle(e.target.value)} />
          <button className="btn ghost" onClick={() => setSelected(null)}>{t('取消')}</button>
          <button
            className="btn primary"
            disabled={selected.length < 2}
            title={selected.length < 2 ? t('至少选择两篇') : undefined}
            onClick={async () => {
              try {
                const collection = await api<{ id: string }>('/collections', { body: { title: collectionTitle, paperIds: selected } });
                location.hash = `#/collection/${collection.id}`;
              } catch (err) {
                fail(err);
              }
            }}
          >
            {t('创建合集')}
          </button>
        </div>
      )}
    </div>
  );
}

/** A paper's first page. The image is rendered once in the browser, then kept in the vault. */
export function PaperCover({ paper }: { paper: PaperSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | undefined>(paper.hasThumb ? `/api/papers/${paper.id}/thumb` : undefined);

  useEffect(() => {
    if (paper.hasThumb || !ref.current) return;
    let alive = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      renderThumb(paper.id)
        .then((blob) => {
          if (alive) setSrc(URL.createObjectURL(blob));
          return api(`/papers/${paper.id}/thumb`, { method: 'PUT', raw: blob });
        })
        .catch(() => {
          /* The card simply has no cover. */
        });
    });
    observer.observe(ref.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [paper.id, paper.hasThumb]);

  return (
    <div className="cover" ref={ref}>
      {src ? <img src={src} alt="" loading="lazy" /> : <div className="cover-blank" />}
    </div>
  );
}

function PaperCard({ paper, selected, onToggle }: { paper: PaperSummary; selected?: boolean; onToggle(): void }) {
  const selecting = selected !== undefined;
  return (
    <a
      className={`card ${selected ? 'selected' : ''}`}
      href={paperHref(paper.id)}
      onClick={(e) => {
        if (selecting) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="card-cover">
        <PaperCover paper={paper} />
        {selecting && <span className="card-check">{selected && <Check size={14} />}</span>}
        {(paper.podcastCount > 0 || paper.blogCount > 0) && (
          <div className="cover-badges">
            {paper.podcastCount > 0 && <span title={t('{count} 期播客', { count: paper.podcastCount })}><AudioLines size={12} />{paper.podcastCount}</span>}
            {paper.blogCount > 0 && <span title={t('{count} 篇博客', { count: paper.blogCount })}><FileText size={12} />{paper.blogCount}</span>}
          </div>
        )}
      </div>
      <div className="card-title serif">{paper.title}</div>
      <div className="card-meta muted">
        {paper.authors[0] && <span>{paper.authors[0]}{paper.authors.length > 1 ? t(' 等') : ''}</span>}
        {paper.year && <span className="mono">{paper.year}</span>}
      </div>
    </a>
  );
}
