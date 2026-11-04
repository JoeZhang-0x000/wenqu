import { Copy, Download, Loader2, Pencil, Plus, Square, Trash2, X } from 'lucide-react';
import { t, tx } from '../../src/shared/i18n';
import { useEffect, useMemo, useState } from 'react';
import { BLOG_STYLES, COLLECTION_MODES, LANGUAGES, isCollectionId, type Blog, type BlogMeta, type PaperFigure } from '../../src/shared/types';
import { api, bumpLibrary, confirmAction, fail, formatDate, jobsStore, settingsStore, toast, useFetch, useStore } from './lib';
import { Markdown } from './Markdown';
import { Field, Select, Switch } from './ui';
import { Thinking } from './ChatPanel';

const styleLabel = (id: string) => {
  const label = BLOG_STYLES.find((s) => s.id === id)?.label;
  return label ? tx(label) : id === 'custom' ? t('自定义') : id;
};

export function BlogPanel({
  paperId,
  initialItem,
  onCite,
  agentName,
}: {
  paperId: string;
  initialItem?: string;
  /** `sourcePaper` is set when the citation points into one of a collection's papers. */
  onCite(page: number, sourcePaper?: string): void;
  agentName: string;
}) {
  const { data: blogs } = useFetch<BlogMeta[]>(`/papers/${paperId}/blogs`);
  const jobs = useStore(jobsStore);
  const running = useMemo(
    () => Object.values(jobs).find((j) => j.kind === 'blog' && j.paperId === paperId && j.status === 'running'),
    [jobs, paperId],
  );
  const [failure, setFailure] = useState<string>();
  const [selected, setSelected] = useState<string | undefined>(initialItem);
  const [composing, setComposing] = useState(false);
  const [lastStarted, setLastStarted] = useState<string>();

  useEffect(() => setSelected(initialItem), [initialItem]);

  // Open the finished post, or fall back to the newest when the selection disappears.
  useEffect(() => {
    if (!blogs) return;
    if (lastStarted && !running && blogs.some((b) => b.id === lastStarted)) {
      setSelected(lastStarted);
      setLastStarted(undefined);
    } else if (!selected || !blogs.some((b) => b.id === selected)) {
      setSelected(blogs[0]?.id);
    }
  }, [blogs, running]);

  // A failed job leaves no post behind, so its error is surfaced on the form.
  useEffect(() => {
    if (!lastStarted || running) return;
    const job = Object.values(jobs).find((j) => j.targetId === lastStarted);
    if (job?.status === 'failed' || job?.status === 'canceled') {
      setFailure(job.status === 'failed' ? job.error : undefined);
      setLastStarted(undefined);
      setComposing(true);
    }
  }, [jobs, lastStarted, running]);

  const showForm = composing || (blogs !== undefined && blogs.length === 0 && !running);

  return (
    <div className="panel-body">
      {blogs && blogs.length > 0 && (
        <div className="versions">
          <select value={selected ?? ''} onChange={(e) => { setSelected(e.target.value); setComposing(false); }}>
            {blogs.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
          <button className="btn" disabled={Boolean(running)} onClick={() => setComposing(!composing)}>
            <Plus size={14} />{t('新博客')}
          </button>
        </div>
      )}
      {running ? (
        <div className="scroll">
          <div className="stream-head">
            <span className="muted">{running.progress?.note ?? t('生成中')} · {agentName}</span>
            <button className="btn ghost" onClick={() => api(`/jobs/${running.id}/cancel`, { method: 'POST' }).catch(fail)}>
              <Square size={12} fill="currentColor" />{t('停止')}
            </button>
          </div>
          {running.text ? <Markdown source={running.text} ownerId={paperId} className="article" /> : <Thinking text={t('{agent} 正在阅读论文', { agent: agentName })} />}
        </div>
      ) : showForm ? (
        <BlogForm
          paperId={paperId}
          error={failure}
          onStarted={(id) => {
            setFailure(undefined);
            setLastStarted(id);
            setComposing(false);
          }}
          onCancel={blogs?.length ? () => setComposing(false) : undefined}
        />
      ) : selected ? (
        <BlogView key={selected} paperId={paperId} blogId={selected} onCite={onCite} />
      ) : null}
    </div>
  );
}

function BlogForm({
  paperId,
  error,
  onStarted,
  onCancel,
}: {
  paperId: string;
  error?: string;
  onStarted(id: string): void;
  onCancel?: () => void;
}) {
  const settings = useStore(settingsStore)!;
  const [style, setStyle] = useState(settings.blog.style);
  const [customStyle, setCustomStyle] = useState(settings.blog.customStyle);
  const [language, setLanguage] = useState(settings.blog.language);
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState('digest');
  const [figures, setFigures] = useState(true);
  const [busy, setBusy] = useState(false);
  const collection = isCollectionId(paperId);
  return (
    <div className="scroll form">
      <h3 className="serif">{collection ? t('把这个合集写成博客') : t('把这篇论文写成博客')}</h3>
      {collection && (
        <Field label={t('形式')}><Select value={mode} options={COLLECTION_MODES} onChange={setMode} /></Field>
      )}
      <div className="row">
        <Field label={t('风格')}><Select value={style} options={BLOG_STYLES} onChange={setStyle} custom /></Field>
        <Field label={t('语言')}><Select value={language} options={LANGUAGES} onChange={setLanguage} /></Field>
      </div>
      {style === 'custom' && (
        <Field label={t('自定义风格')}>
          <textarea rows={3} value={customStyle} placeholder={t('描述你想要的文风、读者和结构')} onChange={(e) => setCustomStyle(e.target.value)} />
        </Field>
      )}
      <Field label={t('额外要求（可选）')}>
        <textarea rows={2} value={instructions} placeholder={t('例如：重点讲第三章的实验，并和 BERT 做对比')} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <div className="figures-option">
        <Switch checked={figures} onChange={setFigures} label={t('插入论文图表')} />
        {figures && !collection && <FigureStrip paperId={paperId} />}
        {figures && collection && <p className="muted small">{t('会从每篇论文中提取带图注的图表，由 Agent 根据图注挑选。')}</p>}
      </div>
      {error && <div className="notice err">{t('上次生成失败：{error}', { error })}</div>}
      <div className="form-actions">
        {onCancel && <button className="btn ghost" onClick={onCancel}>{t('取消')}</button>}
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api<{ blogId: string }>(`/papers/${paperId}/blogs`, { body: { style, customStyle, language, instructions, mode, figures } });
              onStarted(res.blogId);
            } catch (err) {
              fail(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('开始生成')}
        </button>
      </div>
    </div>
  );
}

/** Shows what was detected, so a bad crop can be removed before an agent uses it. */
function FigureStrip({ paperId }: { paperId: string }) {
  const [state, setState] = useState<{ supported: boolean; figures: PaperFigure[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ supported: boolean; figures: PaperFigure[] }>(`/papers/${paperId}/figures`)
      .then((next) => alive && setState(next))
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [paperId]);

  if (!state) {
    return <p className="muted small figures-loading"><Loader2 size={12} className="spin" />{t('正在检测论文图表')}</p>;
  }
  if (!state.supported) return <p className="muted small">{t('当前环境缺少 @napi-rs/canvas，无法提取图表。')}</p>;
  const visible = state.figures.filter((f) => !f.excluded);
  if (!visible.length) return <p className="muted small">{t('没有检测到带图注的图表，这篇博客只会有文字。')}</p>;
  return (
    <>
      <p className="muted small">{t('检测到 {count} 张，由 Agent 根据图注挑选。裁剪不对的可以移除。', { count: visible.length })}</p>
      <div className="figure-strip">
        {visible.map((figure) => (
          <div className="figure-thumb" key={figure.n} title={`${figure.label} (p.${figure.page}): ${figure.caption}`}>
            <img src={`/api/papers/${paperId}/figures/${figure.file}`} alt={figure.label} loading="lazy" />
            <span className="mono">{figure.n}</span>
            <button
              className="figure-remove"
              title={t('移除 {label}', { label: figure.label })}
              onClick={async () => {
                try {
                  const figures = await api<PaperFigure[]>(`/papers/${paperId}/figures/${figure.n}`, { method: 'PATCH', body: { excluded: true } });
                  setState({ ...state, figures });
                } catch (err) {
                  fail(err);
                }
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function BlogView({ paperId, blogId, onCite }: { paperId: string; blogId: string; onCite(page: number, sourcePaper?: string): void }) {
  const { data: blog, setData } = useFetch<Blog>(`/papers/${paperId}/blogs/${blogId}`);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!blog) return null;
  return (
    <div className="scroll">
      <div className="item-meta">
        <span className="muted">{blog.mode ? `${tx(COLLECTION_MODES.find((m) => m.id === blog.mode)?.label ?? '')} · ` : ''}{styleLabel(blog.style)} · {blog.agent} · {formatDate(blog.createdAt)} · {t('{count} 字符', { count: blog.chars.toLocaleString() })}</span>
        <div className="spacer" />
        {!editing && (
          <>
            <button className="icon" title={t('编辑')} onClick={() => { setDraft(blog.markdown); setEditing(true); }}><Pencil size={14} /></button>
            <button
              className="icon"
              title={t('复制 Markdown')}
              onClick={() => navigator.clipboard.writeText(blog.markdown).then(() => toast(t('已复制 Markdown')), fail)}
            >
              <Copy size={14} />
            </button>
            <a className="icon" title={t('下载 .md（图片内嵌）')} href={`/api/papers/${paperId}/blogs/${blogId}/export`}><Download size={14} /></a>
            <button
              className="icon danger"
              title={t('删除')}
              onClick={async () => {
                if (await confirmAction(t('把「{title}」移到 Vault 回收站？', { title: blog.title }), t('删除'))) {
                  await api(`/papers/${paperId}/blogs/${blogId}`, { method: 'DELETE' }).catch(fail);
                  bumpLibrary();
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {editing ? (
        <div className="editor">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setEditing(false)}>{t('取消')}</button>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  setData(await api<Blog>(`/papers/${paperId}/blogs/${blogId}`, { method: 'PUT', body: { markdown: draft } }));
                  setEditing(false);
                  toast(t('已保存'));
                } catch (err) {
                  fail(err);
                }
              }}
            >
              {t('保存')}
            </button>
          </div>
        </div>
      ) : (
        <Markdown
          source={blog.markdown}
          ownerId={paperId}
          className="article"
          onCite={(page, ref) => onCite(page, ref ? blog.sources?.[ref - 1] : undefined)}
        />
      )}
    </div>
  );
}
