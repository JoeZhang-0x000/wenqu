import { MessagesSquare, Minus, PanelRight, PictureInPicture2 } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { t } from '../../src/shared/i18n';

type Mode = 'docked' | 'floating' | 'hidden';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChatDockHandle {
  /** Brings the panel back if it is hidden. */
  reveal(): void;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* A convenience only. */
  }
}

/** Follows the pointer until it is released, even outside the element it started on. */
function track(onMove: (dx: number, dy: number) => void, onEnd: () => void, start: { clientX: number; clientY: number }) {
  document.body.classList.add('resizing');
  const move = (e: PointerEvent) => onMove(e.clientX - start.clientX, e.clientY - start.clientY);
  const up = () => {
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onEnd();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Chat beside the main view, floating over it, or tucked away behind a button. */
export const ChatDock = forwardRef<ChatDockHandle, { busy: boolean; head?: ReactNode; notice?: ReactNode; children: ReactNode }>(
  function ChatDock({ busy, head, notice, children }, ref) {
    const [mode, setModeState] = useState<Mode>(() => load<Mode>('wenqu-chat-mode', 'docked'));
    const [lastVisible, setLastVisible] = useState<Mode>(() => {
      const saved = load<Mode>('wenqu-chat-last', 'docked');
      return saved === 'hidden' ? 'docked' : saved;
    });
    const [width, setWidth] = useState(() => load('wenqu-panel-width', 460));
    const [rect, setRect] = useState<Rect>(() => load('wenqu-chat-float', { x: 40, y: 40, w: 420, h: 560 }));
    const anchorRef = useRef<HTMLDivElement>(null);

    const setMode = (next: Mode) => {
      setModeState(next);
      store('wenqu-chat-mode', next);
      if (next !== 'hidden') {
        setLastVisible(next);
        store('wenqu-chat-last', next);
      }
    };

    useImperativeHandle(ref, () => ({
      reveal() {
        if (mode === 'hidden') setMode(lastVisible);
      },
    }));

    /** The main area the panel floats over, so it can't be lost off screen. */
    const bounds = () => anchorRef.current?.parentElement?.getBoundingClientRect();

    const fit = (next: Rect): Rect => {
      const area = bounds();
      if (!area) return next;
      const w = Math.min(Math.max(MIN_WIDTH, next.w), area.width);
      const h = Math.min(Math.max(MIN_HEIGHT, next.h), area.height);
      return {
        w,
        h,
        x: Math.min(Math.max(0, next.x), area.width - w),
        y: Math.min(Math.max(0, next.y), area.height - h),
      };
    };

    useEffect(() => {
      if (mode !== 'floating') return;
      const parent = anchorRef.current?.parentElement;
      if (!parent) return;
      setRect((current) => fit(current));
      const observer = new ResizeObserver(() => setRect((current) => fit(current)));
      observer.observe(parent);
      return () => observer.disconnect();
    }, [mode]);

    const startSplit = (e: React.PointerEvent) => {
      e.preventDefault();
      const startWidth = width;
      let latest = startWidth;
      track(
        (dx) => {
          latest = Math.min(Math.max(340, startWidth - dx), window.innerWidth - 360);
          setWidth(latest);
        },
        () => store('wenqu-panel-width', latest),
        e,
      );
    };

    const startMove = (e: React.PointerEvent) => {
      if (mode !== 'floating' || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const origin = rect;
      let latest = origin;
      track(
        (dx, dy) => {
          latest = fit({ ...origin, x: origin.x + dx, y: origin.y + dy });
          setRect(latest);
        },
        () => store('wenqu-chat-float', latest),
        e,
      );
    };

    const startResize = (e: React.PointerEvent) => {
      e.preventDefault();
      const origin = rect;
      let latest = origin;
      track(
        (dx, dy) => {
          latest = fit({ ...origin, w: origin.w + dx, h: origin.h + dy });
          setRect(latest);
        },
        () => store('wenqu-chat-float', latest),
        e,
      );
    };

    const style =
      mode === 'docked'
        ? { width }
        : mode === 'floating'
          ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
          : undefined;

    return (
      <>
        <span ref={anchorRef} hidden />
        {mode === 'docked' && <div className="splitter" onPointerDown={startSplit} />}
        {/* One element in every mode, so the conversation and its scroll position survive switching. */}
        <aside className={`side chat-${mode}`} style={style}>
          <div className="side-head" onPointerDown={startMove}>
            <b>{t('问答')}</b>
            {busy && <span className="dot live" />}
            <div className="spacer" />
            {head}
            <button
              className="icon"
              title={mode === 'floating' ? t('停靠到侧边') : t('悬浮')}
              onClick={() => setMode(mode === 'floating' ? 'docked' : 'floating')}
            >
              {mode === 'floating' ? <PanelRight size={15} /> : <PictureInPicture2 size={15} />}
            </button>
            <button className="icon" title={t('隐藏问答')} onClick={() => setMode('hidden')}>
              <Minus size={15} />
            </button>
          </div>
          {notice}
          {children}
          {mode === 'floating' && <div className="float-resize" title={t('拖动调整大小')} onPointerDown={startResize} />}
        </aside>
        {mode === 'hidden' && (
          <button className="chat-launcher" onClick={() => setMode(lastVisible)}>
            <MessagesSquare size={15} />
            {t('问答')}
            {busy && <span className="dot live" />}
          </button>
        )}
      </>
    );
  },
);
