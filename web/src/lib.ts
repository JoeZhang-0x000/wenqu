import { useEffect, useState, useSyncExternalStore } from 'react';
import { getLocale, setLocale, t, type Locale } from '../../src/shared/i18n';
import { isCollectionId, type Job, type Podcast, type PublicSettings, type ServerEvent } from '../../src/shared/types';

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; raw?: BodyInit }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined || init?.raw !== undefined ? 'POST' : 'GET'),
    // Tells the server which language to use for errors and task labels.
    headers: { 'X-P2P-Locale': getLocale(), ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error ?? t('请求失败 ({status})', { status: res.status }));
  return data as T;
}

// Tiny observable store -------------------------------------------------------

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

// Live server state -----------------------------------------------------------

export const jobsStore = createStore<Record<string, Job>>({});
/** Increments whenever vault content may have changed. Lists refetch on it. */
export const libraryTick = createStore(0);
export const settingsStore = createStore<PublicSettings | null>(null);

export const bumpLibrary = () => libraryTick.set(libraryTick.get() + 1);

export const localeStore = createStore<Locale>(getLocale());

function browserLocale(): Locale {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Stores settings and applies the interface language they ask for. */
export function applySettings(settings: PublicSettings) {
  const locale = settings.uiLanguage === 'auto' ? browserLocale() : settings.uiLanguage;
  setLocale(locale);
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  // The locale goes first, so the settings update already renders in the new language.
  localeStore.set(locale);
  settingsStore.set(settings);
}

export async function refreshSettings() {
  setLocale(browserLocale());
  applySettings(await api<PublicSettings>('/settings'));
}

export function connectEvents() {
  const sync = () =>
    api<Job[]>('/jobs').then((jobs) => {
      jobsStore.set(Object.fromEntries(jobs.map((j) => [j.id, j])));
      bumpLibrary();
    });
  const source = new EventSource('/api/events');
  source.onopen = () => void sync();
  source.onmessage = (e) => {
    const event = JSON.parse(e.data) as ServerEvent;
    if (event.type === 'library') bumpLibrary();
    else if (event.type === 'job') jobsStore.set({ ...jobsStore.get(), [event.job.id]: event.job });
    else if (event.type === 'delta') {
      const job = jobsStore.get()[event.jobId];
      if (job) jobsStore.set({ ...jobsStore.get(), [job.id]: { ...job, text: job.text + event.text } });
    }
  };
}

/** Refetches on mount, on dependency change and whenever the vault changes. */
export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const tick = useStore(libraryTick);
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!path) {
      setData(undefined);
      return;
    }
    let alive = true;
    api<T>(path)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, tick, ...deps]);
  return { data, error, setData };
}

// Toasts and confirmation -----------------------------------------------------

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}
export const toastStore = createStore<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  toastStore.set([...toastStore.get(), { id, kind, text }]);
  setTimeout(() => toastStore.set(toastStore.get().filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3000);
}

export const fail = (err: unknown) => toast((err as Error).message ?? String(err), 'error');

export interface ConfirmRequest {
  message: string;
  action: string;
  resolve: (ok: boolean) => void;
}
export const confirmStore = createStore<ConfirmRequest | null>(null);

export function confirmAction(message: string, action = t('确定')): Promise<boolean> {
  return new Promise((resolve) =>
    confirmStore.set({
      message,
      action,
      resolve: (ok) => {
        confirmStore.set(null);
        resolve(ok);
      },
    }),
  );
}

// Audio player ----------------------------------------------------------------

export interface PlayerState {
  paperId: string | null;
  podcast: Podcast | null;
  playing: boolean;
  time: number;
  rate: number;
}

const audio = new Audio();
audio.preload = 'metadata';

export const playerStore = createStore<PlayerState>({ paperId: null, podcast: null, playing: false, time: 0, rate: 1 });
const patchPlayer = (patch: Partial<PlayerState>) => playerStore.set({ ...playerStore.get(), ...patch });

audio.addEventListener('timeupdate', () => patchPlayer({ time: audio.currentTime }));
audio.addEventListener('play', () => patchPlayer({ playing: true }));
audio.addEventListener('pause', () => patchPlayer({ playing: false }));
audio.addEventListener('error', () => {
  if (playerStore.get().podcast) toast(t('音频加载失败'), 'error');
});

export const player = {
  play(paperId: string, podcast: Podcast, at?: number) {
    const state = playerStore.get();
    if (state.podcast?.id !== podcast.id) {
      audio.src = `/api/papers/${paperId}/podcasts/${podcast.id}/audio?v=${encodeURIComponent(podcast.updatedAt)}`;
      audio.playbackRate = state.rate;
      patchPlayer({ paperId, podcast, time: at ?? 0 });
    } else {
      patchPlayer({ podcast });
    }
    if (at !== undefined) audio.currentTime = at;
    audio.play().catch(() => {});
  },
  toggle() {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  },
  seek(time: number) {
    audio.currentTime = Math.max(0, time);
    patchPlayer({ time: audio.currentTime });
  },
  skip(delta: number) {
    player.seek(audio.currentTime + delta);
  },
  setRate(rate: number) {
    audio.playbackRate = rate;
    patchPlayer({ rate });
  },
  close() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    patchPlayer({ paperId: null, podcast: null, playing: false, time: 0 });
  },
};

// Formatting ------------------------------------------------------------------

export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function download(filename: string, content: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Routing ---------------------------------------------------------------------

export interface Route {
  page: 'library' | 'works' | 'paper' | 'collections' | 'collection';
  id?: string;
  tab?: string;
  item?: string;
  /** PDF page to open at. */
  at?: number;
}

function parseHash(): Route {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, id] = path.split('/');
  const detail = { id, tab: params.get('tab') ?? undefined, item: params.get('item') ?? undefined };
  if (head === 'paper' && id) return { page: 'paper', ...detail, at: Number(params.get('at')) || undefined };
  if (head === 'collection' && id) return { page: 'collection', ...detail };
  if (head === 'collections') return { page: 'collections' };
  if (head === 'works') return { page: 'works' };
  return { page: 'library' };
}

export const routeStore = createStore<Route>(parseHash());
window.addEventListener('hashchange', () => routeStore.set(parseHash()));

function detailHref(kind: string, id: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const query = search.toString();
  return `#/${kind}/${id}${query ? `?${query}` : ''}`;
}

export const paperHref = (id: string, tab?: string, item?: string, at?: number) => detailHref('paper', id, { tab, item, at });

/** Links to whatever owns a post or an episode: a paper or a collection. */
export const ownerHref = (id: string, tab?: string, item?: string) =>
  isCollectionId(id) ? detailHref('collection', id, { tab, item }) : paperHref(id, tab, item);
