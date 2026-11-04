import { ChevronDown, ChevronUp, Maximize2, MessageSquareQuote, Minus, Moon, Plus, Search, Sparkles, Languages, X } from 'lucide-react';
import { t } from '../../src/shared/i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { documentOptions, loadPdfjs } from './pdf';

export interface PdfHandle {
  goToPage(page: number): void;
}

export interface SelectionAsk {
  selection: string;
  page?: number;
  prompt?: string;
}

interface Props {
  url: string;
  initialPage?: number;
  /** Hides the viewer without losing the document or the scroll position. */
  hidden?: boolean;
  onAsk(ask: SelectionAsk): void;
}

export const PdfViewer = forwardRef<PdfHandle, Props>(function PdfViewer({ url, initialPage, hidden, onAsk }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const busRef = useRef<any>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(1);
  const [error, setError] = useState<string>();
  const [night, setNight] = useState(() => {
    try {
      return localStorage.getItem('wenqu-night-pdf') === '1';
    } catch {
      return false;
    }
  });
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number; text: string; page?: number } | null>(null);

  useImperativeHandle(ref, () => ({
    goToPage(n) {
      const viewer = viewerRef.current;
      if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
    },
  }));

  useEffect(() => {
    let task: any;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    (async () => {
      const { pdfjs, viewer: lib } = await loadPdfjs();
      if (disposed || !containerRef.current) return;
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({ eventBus, externalLinkTarget: 2 });
      const findController = new lib.PDFFindController({ eventBus, linkService });
      const viewer = new lib.PDFViewer({
        container: containerRef.current,
        eventBus,
        linkService,
        findController,
        removePageBorders: true,
      });
      linkService.setViewer(viewer);
      viewerRef.current = viewer;
      busRef.current = eventBus;
      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        if (initialPage) viewer.currentPageNumber = initialPage;
      });
      eventBus.on('pagechanging', (e: any) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
      });
      eventBus.on('scalechanging', (e: any) => setScale(e.scale));
      eventBus.on('updatefindmatchescount', (e: any) => setMatches(e.matchesCount));
      eventBus.on('updatefindcontrolstate', (e: any) => {
        if (e.matchesCount) setMatches(e.matchesCount);
      });
      observer = new ResizeObserver(() => {
        // A hidden container has no width to fit to.
        if (!containerRef.current?.clientWidth) return;
        if (['page-width', 'page-fit'].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
      });
      observer.observe(containerRef.current);
      task = pdfjs.getDocument(documentOptions(url) as any);
      const doc = await task.promise;
      if (disposed) return;
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      setPages(doc.numPages);
    })().catch((err) => {
      if (!disposed) setError(err.message);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      viewerRef.current = null;
      task?.destroy();
    };
  }, [url]);

  const zoom = (factor: number) => {
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScale = Math.min(5, Math.max(0.3, viewer.currentScale * factor));
  };

  const find = (type: string, findPrevious = false, text = query) => {
    busRef.current?.dispatch('find', {
      source: null,
      type,
      query: text,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  };

  const onMouseUp = () => {
    // Runs after the browser has finished updating the selection.
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection || !text || selection.rangeCount === 0 || !containerRef.current?.contains(selection.anchorNode)) {
        setBubble(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const wrap = wrapRef.current!.getBoundingClientRect();
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      const pageEl = anchor?.closest('.page') as HTMLElement | null;
      setBubble({
        x: Math.min(Math.max(120, rect.left + rect.width / 2 - wrap.left), wrap.width - 120),
        y: Math.max(8, rect.top - wrap.top - 46),
        text: text.replace(/\s*\n\s*/g, ' '),
        page: pageEl?.dataset.pageNumber ? Number(pageEl.dataset.pageNumber) : undefined,
      });
    });
  };

  const ask = (prompt?: string) => {
    if (!bubble) return;
    onAsk({ selection: bubble.text, page: bubble.page, prompt });
    setBubble(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className={`pdf ${night ? 'pdf-night' : ''}`} ref={wrapRef} style={hidden ? { display: 'none' } : undefined}>
      <div className="pdf-bar">
        <div className="pdf-pager">
          <input
            aria-label={t('页码')}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const n = Number(pageInput);
              if (viewerRef.current && n >= 1 && n <= pages) viewerRef.current.currentPageNumber = n;
              else setPageInput(String(page));
            }}
          />
          <span>/ {pages || '–'}</span>
        </div>
        <div className="pdf-zoom">
          <button className="icon" title={t('缩小')} onClick={() => zoom(0.9)}><Minus size={15} /></button>
          <span className="pdf-scale">{Math.round(scale * 100)}%</span>
          <button className="icon" title={t('放大')} onClick={() => zoom(1.1)}><Plus size={15} /></button>
          <button
            className="icon"
            title={t('适应宽度')}
            onClick={() => {
              if (viewerRef.current) viewerRef.current.currentScaleValue = 'page-width';
            }}
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <div className="spacer" />
        <button
          className={`icon ${night ? 'on' : ''}`}
          title={t('夜读模式')}
          onClick={() => {
            setNight(!night);
            try {
              localStorage.setItem('wenqu-night-pdf', night ? '0' : '1');
            } catch {
              /* A convenience only. */
            }
          }}
        >
          <Moon size={15} />
        </button>
        <button className={`icon ${finding ? 'on' : ''}`} title={t('在论文中搜索')} onClick={() => setFinding(!finding)}>
          <Search size={15} />
        </button>
      </div>
      {finding && (
        <div className="pdf-find">
          <input
            autoFocus
            placeholder={t('在论文中搜索')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              find('', false, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find('again', e.shiftKey);
              if (e.key === 'Escape') setFinding(false);
            }}
          />
          <span className="muted mono">{query && matches ? `${matches.current}/${matches.total}` : ''}</span>
          <button className="icon" title={t('上一个')} onClick={() => find('again', true)}><ChevronUp size={15} /></button>
          <button className="icon" title={t('下一个')} onClick={() => find('again', false)}><ChevronDown size={15} /></button>
          <button
            className="icon"
            title={t('关闭搜索')}
            onClick={() => {
              setFinding(false);
              setQuery('');
              find('', false, '');
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {error && <div className="pdf-error">{t('无法打开 PDF：{error}', { error })}</div>}
      <div className="pdf-stage">
        <div className="pdf-scroll" ref={containerRef} onMouseUp={onMouseUp} onScroll={() => bubble && setBubble(null)}>
          <div className="pdfViewer" />
        </div>
      </div>
      {bubble && (
        <div className="bubble" style={{ left: bubble.x, top: bubble.y }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => ask()}><MessageSquareQuote size={14} />{t('提问')}</button>
          <button onClick={() => ask(t('解释这段内容在论文中的含义，必要时补充背景。'))}><Sparkles size={14} />{t('解释')}</button>
          <button onClick={() => ask(t('把这段翻译成中文，保留术语原文。如果原文已是中文，则翻译成英文。'))}><Languages size={14} />{t('翻译')}</button>
        </div>
      )}
    </div>
  );
});
