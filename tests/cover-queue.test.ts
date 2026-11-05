import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  renderFigureCover: vi.fn(),
  renderPageCover: vi.fn(),
}));
vi.mock('../web/src/lib', () => ({ api: mocks.api }));
vi.mock('../web/src/pdf', () => ({ renderFigureCover: mocks.renderFigureCover, renderPageCover: mocks.renderPageCover }));

const blob = new Blob(['jpeg']);
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const calls = () => mocks.api.mock.calls.map(([path]) => path as string);

describe('requestCover', () => {
  let requestCover: typeof import('../web/src/cover').requestCover;
  let coverUrl: typeof import('../web/src/cover').coverUrl;
  /** What the server would plan for each paper. */
  let plans: Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();
    ({ requestCover, coverUrl } = await import('../web/src/cover'));
    plans = {};
    mocks.renderFigureCover.mockReset().mockResolvedValue(blob);
    mocks.renderPageCover.mockReset().mockResolvedValue(blob);
    mocks.api.mockReset().mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return { thumbStamp: 42 };
      if (init?.method === 'POST') return { ok: true };
      return plans[path.split('/')[2]] ?? { settled: false, page: 1 };
    });
  });

  it('uploads a crop, says how it was chosen, and tells the card', async () => {
    plans.a = { settled: false, figure: 'fig-1.png', page: 3 };
    const onReady = vi.fn();
    requestCover('a', onReady);
    await flush();
    expect(mocks.renderFigureCover).toHaveBeenCalledWith('a', 'fig-1.png');
    expect(mocks.renderPageCover).not.toHaveBeenCalled();
    expect(calls()).toContain('/papers/a/thumb?kind=figure&page=3');
    expect(onReady).toHaveBeenCalledWith('/api/papers/a/thumb?v=42');
  });

  it('falls back from the crop to its page, then to page 1', async () => {
    plans.a = { settled: false, figure: 'fig-1.png', page: 3 };
    mocks.renderFigureCover.mockRejectedValue(new Error('no image'));
    requestCover('a', () => {});
    await flush();
    expect(mocks.renderPageCover).toHaveBeenCalledWith('a', 3);
    expect(calls()).toContain('/papers/a/thumb?kind=page&page=3');

    plans.b = { settled: false, figure: 'fig-1.png', page: 3 };
    mocks.renderPageCover.mockImplementation(async (_id: string, page: number) => {
      if (page !== 1) throw new Error('no page');
      return blob;
    });
    requestCover('b', () => {});
    await flush();
    expect(calls()).toContain('/papers/b/thumb?kind=page&page=1');
  });

  it('settles as failed when nothing can be drawn, and leaves the card alone', async () => {
    mocks.renderPageCover.mockRejectedValue(new Error('corrupt'));
    const onReady = vi.fn();
    requestCover('a', onReady);
    await flush();
    expect(calls()).toEqual(['/papers/a/cover', '/papers/a/cover/failed']);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('does not try again in this page load after an error', async () => {
    mocks.api.mockRejectedValueOnce(new Error('server down'));
    requestCover('a', () => {});
    await flush();
    requestCover('a', () => {});
    requestCover('a', () => {});
    await flush();
    expect(calls()).toEqual(['/papers/a/cover']);
  });

  it('shows a cover it could not save, and does not draw it again in this page load', async () => {
    mocks.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new Error('read-only vault');
      return { settled: false, page: 1 };
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:cover' });
    const onReady = vi.fn();
    requestCover('a', onReady);
    await flush();
    vi.unstubAllGlobals();
    expect(onReady).toHaveBeenCalledWith('blob:cover');
    requestCover('a', () => {});
    await flush();
    expect(mocks.renderPageCover).toHaveBeenCalledTimes(1);
  });

  it('can run again for a cover made stale since, such as by removing a bad crop', async () => {
    plans.a = { settled: false, figure: 'fig-1.png', page: 1 };
    requestCover('a', () => {});
    await flush();
    plans.a = { settled: false, figure: 'fig-2.png', page: 2 };
    requestCover('a', () => {});
    await flush();
    expect(mocks.renderFigureCover).toHaveBeenLastCalledWith('a', 'fig-2.png');
  });

  it('adopts a cover another tab already settled, without drawing', async () => {
    plans.a = { settled: true, thumbStamp: 7 };
    const onReady = vi.fn();
    requestCover('a', onReady);
    await flush();
    expect(mocks.renderPageCover).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith('/api/papers/a/thumb?v=7');
  });

  it('runs one at a time', async () => {
    let release!: (value: Blob) => void;
    mocks.renderPageCover.mockImplementationOnce(() => new Promise<Blob>((resolve) => (release = resolve)));
    requestCover('a', () => {});
    requestCover('b', () => {});
    await flush();
    expect(calls()).toEqual(['/papers/a/cover']);
    release(blob);
    await flush();
    expect(calls()).toContain('/papers/b/cover');
  });

  it('skips a card scrolled away before its turn, and comes back to it when seen again', async () => {
    let release!: (value: Blob) => void;
    mocks.renderPageCover.mockImplementationOnce(() => new Promise<Blob>((resolve) => (release = resolve)));
    requestCover('a', () => {});
    const stop = requestCover('b', () => {});
    await flush();
    stop();
    release(blob);
    await flush();
    expect(calls()).not.toContain('/papers/b/cover');

    const onReady = vi.fn();
    requestCover('b', onReady);
    await flush();
    expect(calls()).toContain('/papers/b/cover');
    expect(onReady).toHaveBeenCalled();
  });

  it('shares one job between cards showing the same paper', async () => {
    const first = vi.fn();
    const second = vi.fn();
    requestCover('a', first);
    requestCover('a', second);
    await flush();
    expect(calls().filter((path) => path === '/papers/a/cover')).toHaveLength(1);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('points at the image for the current stamp', () => {
    const paper = { id: 'a', hasThumb: true, thumbStamp: 1 } as any;
    expect(coverUrl(paper)).toBe('/api/papers/a/thumb?v=1');
    expect(coverUrl({ ...paper, hasThumb: false })).toBeUndefined();
  });
});
