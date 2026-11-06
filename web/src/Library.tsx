import { AudioLines, Check, FileText, Layers, LayoutGrid, Link2, Plus, Rows3, Search, Tag, Upload } from 'lucide-react';
import { getLocale, t } from '../../src/shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { countTags, type PaperSummary } from '../../src/shared/types';
import { openAddPaper } from './AddPaper';
import { api, fail, paperHref, useFetch } from './lib';
import { coverUrl, requestCover } from './cover';

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

/** Enough to find the common ones without the row taking over the page. */
const TAGS_SHOWN = 12;
const TAGS_ON_CARD = 3;
const AUTHORS_IN_FEED = 4;

/** Cards are for scanning a lot of papers, and the feed gives each one room for its abstract. */
type View = 'cards' | 'feed';
const VIEW_KEY = 'wenqu-library-view';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'feed' ? 'feed' : 'cards';
  } catch {
    return 'cards';
  }
}

function saveView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* The choice just lasts until the next load. */
  }
}

export function Library() {
  const { data: papers } = useFetch<PaperSummary[]>('/papers');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>(savedView);
  const [chosenTags, setChosenTags] = useState<string[]>([]);
  const [chosenUntagged, setChosenUntagged] = useState(false);
  const [allTagsShown, setAllTagsShown] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [collectionTitle, setCollectionTitle] = useState('');

  const tagCounts = useMemo(() => countTags(papers ?? []), [papers]);
  const untaggedCount = useMemo(() => (papers ?? []).filter((p) => !p.tags.length).length, [papers]);
  // A tag can disappear while it is chosen, and shouldn't go on hiding papers with no chip left to turn it off.
  const activeTags = useMemo(() => chosenTags.filter((tag) => tagCounts.some((c) => c.tag === tag)), [chosenTags, tagCounts]);
  const untagged = chosenUntagged && untaggedCount > 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (papers ?? []).filter((p) => {
      if (filter === 'blog' && !p.blogCount) return false;
      if (filter === 'podcast' && !p.podcastCount) return false;
      if (filter === 'none' && (p.blogCount || p.podcastCount)) return false;
      if (untagged && p.tags.length) return false;
      if (!activeTags.every((tag) => p.tags.includes(tag))) return false;
      return !q || `${p.title} ${p.authors.join(' ')} ${p.abstract ?? ''} ${p.tags.join(' ')}`.toLowerCase().includes(q);
    });
  }, [papers, query, filter, activeTags, untagged]);

  const toggleTag = (tag: string) => {
    setChosenUntagged(false);
    setChosenTags(activeTags.includes(tag) ? activeTags.filter((other) => other !== tag) : [...activeTags, tag]);
  };
  // The ones in use stay in the row, wherever they rank.
  const shownTags = allTagsShown ? tagCounts : tagCounts.filter((c, i) => i < TAGS_SHOWN || activeTags.includes(c.tag));

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
        <div className="shelf-view" role="group" aria-label={t('书架视图')}>
          {[
            { id: 'cards' as const, label: t('卡片流'), icon: <LayoutGrid size={15} /> },
            { id: 'feed' as const, label: t('瀑布流'), icon: <Rows3 size={15} /> },
          ].map((option) => (
            <button
              key={option.id}
              className={view === option.id ? 'on' : ''}
              title={option.label}
              aria-label={option.label}
              aria-pressed={view === option.id}
              onClick={() => {
                setView(option.id);
                saveView(option.id);
              }}
            >
              {option.icon}
            </button>
          ))}
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
      {tagCounts.length > 0 && (
        <div className="chips tag-filters" role="group" aria-label={t('按标签筛选')}>
          <Tag size={13} aria-hidden />
          {shownTags.map(({ tag, count }) => (
            <button key={tag} className={`chip ${activeTags.includes(tag) ? 'on' : ''}`} aria-pressed={activeTags.includes(tag)} onClick={() => toggleTag(tag)}>
              {tag}<span className="mono tag-count">{count}</span>
            </button>
          ))}
          {untaggedCount > 0 && (
            <button
              className={`chip ${untagged ? 'on' : ''}`}
              aria-pressed={untagged}
              onClick={() => {
                setChosenTags([]);
                setChosenUntagged(!untagged);
              }}
            >
              {t('无标签')}<span className="mono tag-count">{untaggedCount}</span>
            </button>
          )}
          {tagCounts.length > TAGS_SHOWN && (
            <button className="tag-more" onClick={() => setAllTagsShown(!allTagsShown)}>
              {allTagsShown ? t('收起') : t('还有 {count} 个', { count: tagCounts.length - shownTags.length })}
            </button>
          )}
        </div>
      )}
      <div className={`shelf ${view}`}>
        {visible.map((p) => (
          <PaperCard
            key={p.id}
            paper={p}
            view={view}
            selected={selected ? selected.includes(p.id) : undefined}
            activeTags={activeTags}
            onTag={toggleTag}
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

/** A paper's figure, or a page. The image is made once in the browser, then kept in the vault. */
export function PaperCover({ paper }: { paper: PaperSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const [updated, setUpdated] = useState<string>();
  const src = updated ?? coverUrl(paper);

  useEffect(() => {
    if (!paper.coverStale || !ref.current) return;
    let stop: (() => void) | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1].isIntersecting) stop ??= requestCover(paper.id, setUpdated);
      else {
        stop?.();
        stop = undefined;
      }
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      stop?.();
    };
  }, [paper.id, paper.coverStale]);

  return (
    <div className="cover" ref={ref}>
      {src ? <img src={src} alt="" loading="lazy" /> : <div className="cover-blank" />}
    </div>
  );
}

function PaperCard({
  paper,
  view,
  selected,
  activeTags,
  onTag,
  onToggle,
}: {
  paper: PaperSummary;
  view: View;
  selected?: boolean;
  activeTags: string[];
  onTag(tag: string): void;
  onToggle(): void;
}) {
  const selecting = selected !== undefined;
  const feed = view === 'feed';
  // Authors read from a PDF can include stray punctuation.
  const authors = paper.authors.filter((name) => /\p{L}/u.test(name));
  const shownAuthors = authors.slice(0, feed ? AUTHORS_IN_FEED : 1);
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
      <div className="card-title serif" title={paper.title}>{paper.title}</div>
      <div className="card-meta muted">
        {shownAuthors.length > 0 && <span>{shownAuthors.join(', ')}{authors.length > shownAuthors.length ? t(' 等') : ''}</span>}
        {paper.year && <span className="mono">{paper.year}</span>}
      </div>
      {feed && paper.abstract && <p className="card-abstract">{paper.abstract}</p>}
      {paper.tags.length > 0 && (
        <div className="card-tags">
          {/* Inside a link, so these stay plain text for assistive tech. The row above the shelf does the same job by keyboard. */}
          {paper.tags.slice(0, TAGS_ON_CARD).map((tag) => (
            <span
              key={tag}
              className={`card-tag ${activeTags.includes(tag) ? 'on' : ''}`}
              title={tag}
              onClick={(e) => {
                if (selecting) return;
                e.preventDefault();
                onTag(tag);
              }}
            >
              {tag}
            </span>
          ))}
          {paper.tags.length > TAGS_ON_CARD && <span className="card-tag-more" title={paper.tags.slice(TAGS_ON_CARD).join(', ')}>+{paper.tags.length - TAGS_ON_CARD}</span>}
        </div>
      )}
    </a>
  );
}
