import { Check, CircleAlert, FileUp, Link2, Loader2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../src/shared/i18n';
import type { ArxivLookup, PaperSummary } from '../../src/shared/types';
import { api, bumpLibrary, createStore, fail, paperHref, toast, useStore } from './lib';

type Tab = 'file' | 'link';

export const addPaperStore = createStore<{ tab: Tab } | null>(null);
export const openAddPaper = (tab: Tab = 'file') => addPaperStore.set({ tab });

interface ImportItem {
  key: number;
  name: string;
  state: 'running' | 'done' | 'failed';
  retry(): void;
  paper?: PaperSummary;
  duplicate?: boolean;
  error?: string;
}

/** Survives closing the dialog, because imports carry on without it. */
const importsStore = createStore<ImportItem[]>([]);
let importKey = 0;

async function runImport(name: string, request: () => Promise<{ paper: PaperSummary; duplicate: boolean }>): Promise<void> {
  const key = ++importKey;
  const patch = (next: Partial<ImportItem>) => importsStore.set(importsStore.get().map((i) => (i.key === key ? { ...i, ...next } : i)));
  // With the dialog closed the result goes to a toast, so it needn't wait in the list.
  const forget = () => importsStore.set(importsStore.get().filter((i) => i.key !== key));
  const retry = () => {
    forget();
    void runImport(name, request);
  };
  importsStore.set([{ key, name, state: 'running', retry }, ...importsStore.get()]);
  try {
    const { paper, duplicate } = await request();
    patch({ state: 'done', paper, duplicate });
    if (!addPaperStore.get()) {
      toast(duplicate ? t('已经在库里：{title}', { title: paper.title }) : t('已导入：{title}', { title: paper.title }));
      forget();
    }
  } catch (err) {
    const error = (err as Error).message;
    patch({ state: 'failed', error });
    if (!addPaperStore.get()) {
      fail(new Error(`${name}：${error}`));
      forget();
    }
  }
  bumpLibrary();
}

export async function importFiles(files: File[]) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) {
    toast(t('只支持 PDF 文件'), 'error');
    return;
  }
  for (const file of pdfs) {
    await runImport(file.name, () => api(`/papers?filename=${encodeURIComponent(file.name)}`, { raw: file }));
  }
}

/** Answers already known, so editing a list only asks arXiv about what is new. */
const lookupCache = new Map<string, ArxivLookup>();

/** One input per link or id, in the order pasted, without repeats. */
const splitLinks = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];

export function AddPaperDialog() {
  const open = useStore(addPaperStore);
  const items = useStore(importsStore);
  // Held here so it survives switching tabs.
  const [linkText, setLinkText] = useState('');
  const close = () => {
    addPaperStore.set(null);
    setLinkText('');
    lookupCache.clear();
    importsStore.set(importsStore.get().filter((i) => i.state === 'running'));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="add-paper" role="dialog" aria-label={t('添加论文')}>
        <header className="add-paper-head">
          <h2 className="serif">{t('添加论文')}</h2>
          <button className="icon" title={t('关闭')} onClick={close}><X size={18} /></button>
        </header>
        <div className="add-paper-tabs" role="tablist">
          <button role="tab" aria-selected={open.tab === 'file'} className={open.tab === 'file' ? 'on' : ''} onClick={() => addPaperStore.set({ tab: 'file' })}>
            <FileUp size={15} />{t('本地文件')}
          </button>
          <button role="tab" aria-selected={open.tab === 'link'} className={open.tab === 'link' ? 'on' : ''} onClick={() => addPaperStore.set({ tab: 'link' })}>
            <Link2 size={15} />{t('论文链接')}
          </button>
        </div>
        <div className="add-paper-body">
          {open.tab === 'file' ? <FilePane /> : <LinkPane text={linkText} setText={setLinkText} onOpenPaper={close} />}
          {items.length > 0 && (
            <ul className="import-list">
              {items.map((item) => <ImportRow key={item.key} item={item} onOpen={close} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportRow({ item, onOpen }: { item: ImportItem; onOpen(): void }) {
  return (
    <li className="import-row">
      {item.state === 'running' && <Loader2 size={15} className="spin" />}
      {item.state === 'done' && <Check size={15} className="ok" />}
      {item.state === 'failed' && <CircleAlert size={15} className="over" />}
      <div className="grow">
        {item.paper ? (
          <a className="import-title" href={paperHref(item.paper.id)} onClick={onOpen}>{item.paper.title}</a>
        ) : (
          <span className="import-title">{item.name}</span>
        )}
        {item.state === 'running' && <div className="muted small">{t('正在导入')}</div>}
        {item.state === 'failed' && <div className="over small">{item.error}</div>}
        {item.duplicate && <div className="muted small">{t('已在书架中')}</div>}
      </div>
      {item.state === 'failed' && <button className="btn small" onClick={item.retry}>{t('重试')}</button>}
    </li>
  );
}

function FilePane() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          void importFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <button className="add-paper-drop" onClick={() => fileRef.current?.click()}>
        <Upload size={24} strokeWidth={1.5} />
        <span>{t('点击选择 PDF，或把文件拖到这里')}</span>
        <span className="muted small">{t('可以一次选择多个文件')}</span>
      </button>
    </>
  );
}

function LinkPane({ text, setText, onOpenPaper }: { text: string; setText(text: string): void; onOpenPaper(): void }) {
  const [lookups, setLookups] = useState<ArxivLookup[]>();
  const [checking, setChecking] = useState(false);
  const inputs = splitLinks(text);
  const key = inputs.join('\n');

  // Waits for a pause in typing, and ignores answers about text that has since changed.
  useEffect(() => {
    setLookups(undefined);
    if (!inputs.length) {
      setChecking(false);
      return;
    }
    const fresh = inputs.filter((input) => !lookupCache.has(input));
    if (!fresh.length) {
      setChecking(false);
      setLookups(inputs.flatMap((input) => lookupCache.get(input) ?? []));
      return;
    }
    let alive = true;
    setChecking(true);
    const timer = setTimeout(() => {
      api<ArxivLookup[]>('/papers/arxiv/lookup', { body: { inputs: fresh } })
        .then((results) => {
          // `unknown` means arXiv couldn't answer, so it's worth asking again next time.
          const answered = new Map(results.map((r) => [r.input, r]));
          for (const result of results) if (result.status !== 'unknown') lookupCache.set(result.input, result);
          if (alive) setLookups(inputs.flatMap((input) => answered.get(input) ?? lookupCache.get(input) ?? []));
        })
        .catch((err) => alive && fail(err))
        .finally(() => alive && setChecking(false));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);

  const addable = lookups?.filter((l) => l.id && !l.paperId && l.status !== 'missing') ?? [];

  const submit = () => {
    if (!addable.length) return;
    // What can't be added stays in the box, next to its reason, so it can be corrected.
    setText((lookups ?? []).filter((l) => !addable.includes(l) && !l.paperId).map((l) => l.input).join('\n'));
    for (const lookup of addable) lookupCache.delete(lookup.input);
    void (async () => {
      for (const lookup of addable) {
        await runImport(lookup.meta?.title ?? lookup.id!, () => api('/papers/arxiv', { body: { input: lookup.input } }));
      }
    })();
  };

  return (
    <div className="add-paper-link">
      <textarea
        autoFocus
        rows={3}
        aria-label={t('论文链接')}
        placeholder={'https://arxiv.org/abs/1706.03762\n2005.14165'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <p className="muted small">{t('目前支持 arXiv 的链接或编号，一次可以粘贴多个。')}</p>
      {checking && <p className="muted small add-paper-checking"><Loader2 size={13} className="spin" />{t('正在查询 arXiv')}</p>}
      {lookups && (
        <ul className="lookup-list">
          {lookups.map((l) => <LookupRow key={l.input} lookup={l} onOpenPaper={onOpenPaper} />)}
        </ul>
      )}
      <div className="form-actions">
        <button className="btn primary" disabled={!addable.length} onClick={submit}>
          {addable.length > 1 ? t('添加 {count} 篇', { count: addable.length }) : t('添加')}
        </button>
      </div>
    </div>
  );
}

function LookupRow({ lookup, onOpenPaper }: { lookup: ArxivLookup; onOpenPaper(): void }) {
  if (lookup.status === 'invalid') {
    return <li className="lookup-row"><b>{lookup.input}</b><span className="over small">{t('这不是有效的 arXiv 链接或编号')}</span></li>;
  }
  if (lookup.status === 'missing') {
    return <li className="lookup-row"><b>{lookup.input}</b><span className="over small">{t('arXiv 上找不到 {id}', { id: lookup.id! })}</span></li>;
  }
  const { meta } = lookup;
  return (
    <li className="lookup-row">
      <b className="serif">{meta?.title ?? lookup.id}</b>
      {meta && (
        <span className="muted small">
          {meta.authors.slice(0, 3).join(', ')}{meta.authors.length > 3 ? t(' 等') : ''}{meta.year ? ` · ${meta.year}` : ''}
        </span>
      )}
      {!meta && <span className="muted small">{t('暂时无法获取论文信息，仍可以添加')}</span>}
      {lookup.paperId && <a className="small" href={paperHref(lookup.paperId)} onClick={onOpenPaper}>{t('已在书架中')}</a>}
    </li>
  );
}
