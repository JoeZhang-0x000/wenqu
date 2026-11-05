import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/shared/i18n';
import { COLLECTION_ID_PREFIX, type Job, type JobKind } from '../src/shared/types';
import { decideJobNotice, shouldOfferNotifications, type NoticeContext, type OfferContext } from '../web/src/jobNotice';
import { parseRoute } from '../web/src/routes';

const job = (kind: JobKind, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind,
  paperId: 'p1',
  targetId: 't1',
  label: 'Blog: Attention',
  status,
  text: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const away: NoticeContext = { looking: false, notificationsOn: true, route: parseRoute('#/'), announced: new Set() };
const here: NoticeContext = { ...away, looking: true };
const finish = (kind: JobKind, status: Job['status'], context: NoticeContext = away, extra: Partial<Job> = {}) =>
  decideJobNotice(job(kind, 'running', extra), job(kind, status, extra), context);

describe('which changes are announced', () => {
  afterEach(() => setLocale('en'));

  it.each(['blog', 'script', 'synth', 'assistant'] as const)('announces %s when it finishes or fails', (kind) => {
    expect(finish(kind, 'done')?.via).toBe('system');
    expect(finish(kind, 'failed')?.via).toBe('system');
  });

  it.each(['chat', 'tags'] as const)('never announces %s', (kind) => {
    expect(finish(kind, 'done')).toBeNull();
    expect(finish(kind, 'failed')).toBeNull();
  });

  it('never announces a canceled job', () => {
    for (const context of [away, here]) expect(finish('blog', 'canceled', context)).toBeNull();
  });

  it('ignores updates while a job is still running', () => {
    expect(finish('synth', 'running')).toBeNull();
  });

  it('stays quiet about jobs a reload or reconnect lists as already finished', () => {
    expect(decideJobNotice(undefined, job('blog', 'done'), away)).toBeNull();
    expect(decideJobNotice(job('blog', 'done'), job('blog', 'done'), away)).toBeNull();
    expect(decideJobNotice(job('blog', 'failed'), job('blog', 'failed'), away)).toBeNull();
  });

  it('announces a job that finished while the stream was down', () => {
    // `previous` is what this page last saw, `job` comes from the list fetched after reconnecting.
    expect(decideJobNotice(job('blog', 'running'), job('blog', 'done'), away)?.via).toBe('system');
  });

  it('announces once, even if a stale list makes the job look like it is running again', () => {
    const announced = new Set(['j1']);
    expect(decideJobNotice(job('blog', 'running'), job('blog', 'done'), { ...away, announced })).toBeNull();
  });
});

describe('how a finished job is announced', () => {
  it('uses a system notification only when the user is away and it is switched on', () => {
    expect(finish('blog', 'done', away)?.via).toBe('system');
    expect(finish('blog', 'done', { ...away, notificationsOn: false })?.via).toBe('none');
    expect(finish('blog', 'done', here)?.via).toBe('toast');
    expect(finish('blog', 'done', { ...here, notificationsOn: false })?.via).toBe('toast');
  });

  it('skips the toast for a success on the page that shows the result', () => {
    const on = (hash: string) => ({ ...here, route: parseRoute(hash) });
    expect(finish('blog', 'done', on('#/paper/p1?tab=blog'))?.via).toBe('none');
    expect(finish('script', 'done', on('#/paper/p1?tab=podcast'))?.via).toBe('none');
    expect(finish('synth', 'done', on('#/paper/p1?tab=podcast&item=t1'))?.via).toBe('none');
    expect(finish('assistant', 'done', on('#/assistant/t1'))?.via).toBe('none');
  });

  it('always toasts a failed generation, even on the page that shows the result', () => {
    const on = (hash: string) => ({ ...here, route: parseRoute(hash) });
    expect(finish('blog', 'failed', on('#/paper/p1?tab=blog'))?.via).toBe('toast');
    expect(finish('script', 'failed', on('#/paper/p1?tab=podcast'))?.via).toBe('toast');
    expect(finish('synth', 'failed', on('#/paper/p1?tab=podcast&item=t1'))?.via).toBe('toast');
    expect(finish('blog', 'failed', { ...on('#/paper/p1?tab=blog'), notificationsOn: false })?.via).toBe('toast');
  });

  it('skips the toast for a failed assistant turn in its own session, which shows the error', () => {
    const on = (hash: string) => ({ ...here, route: parseRoute(hash) });
    expect(finish('assistant', 'failed', on('#/assistant/t1'))?.via).toBe('none');
    expect(finish('assistant', 'failed', on('#/assistant/other'))?.via).toBe('toast');
  });

  it('still toasts on another tab, paper or session', () => {
    const on = (hash: string) => ({ ...here, route: parseRoute(hash) });
    expect(finish('blog', 'done', on('#/paper/p1'))?.via).toBe('toast');
    expect(finish('blog', 'done', on('#/paper/p1?tab=podcast'))?.via).toBe('toast');
    expect(finish('blog', 'done', on('#/paper/p2?tab=blog'))?.via).toBe('toast');
    expect(finish('assistant', 'done', on('#/assistant/other'))?.via).toBe('toast');
    expect(finish('assistant', 'done', on('#/assistant'))?.via).toBe('toast');
  });

  it('notifies even on the result page when the user is not looking at it', () => {
    expect(finish('blog', 'done', { ...away, route: parseRoute('#/paper/p1?tab=blog') })?.via).toBe('system');
  });

  it('marks failures', () => {
    expect(finish('blog', 'failed', here)?.failed).toBe(true);
    expect(finish('blog', 'done', here)?.failed).toBe(false);
  });
});

describe('what it says', () => {
  afterEach(() => setLocale('en'));

  it('separates waiting for approval from a finished reply', () => {
    expect(finish('assistant', 'done')?.title).toBe('The assistant replied');
    const waiting = finish('assistant', 'done', away, { awaitingApproval: true });
    expect(waiting?.title).toBe('The assistant needs your approval');
    expect(waiting?.failed).toBe(false);
  });

  it('says failed when a turn fails, even with cards still waiting', () => {
    expect(finish('assistant', 'failed', away, { awaitingApproval: true })?.title).toBe('The assistant failed');
  });

  it('has a failure title for every kind', () => {
    expect(finish('blog', 'failed')?.title).toBe('Blog post failed');
    expect(finish('script', 'failed')?.title).toBe('Podcast script failed');
    expect(finish('synth', 'failed')?.title).toBe('Podcast audio failed');
  });

  it('follows the interface language', () => {
    setLocale('zh');
    expect(finish('blog', 'done')?.title).toBe('博客已生成');
  });

  it('uses the job label as the body and a tag from the job id', () => {
    const notice = finish('blog', 'done');
    expect(notice?.body).toBe('Blog: Attention');
    expect(notice?.tag).toBe('wenqu-job-j1');
  });
});

describe('where it links', () => {
  const href = (kind: JobKind, status: Job['status'], extra: Partial<Job> = {}) => finish(kind, status, away, extra)?.href;
  const collection = `${COLLECTION_ID_PREFIX}c1`;

  it('opens the result on its tab', () => {
    expect(href('blog', 'done')).toBe('#/paper/p1?tab=blog&item=t1');
    expect(href('script', 'done')).toBe('#/paper/p1?tab=podcast&item=t1');
    expect(href('synth', 'done')).toBe('#/paper/p1?tab=podcast&item=t1');
  });

  it('uses the collection page for a collection', () => {
    expect(href('blog', 'done', { paperId: collection })).toBe(`#/collection/${collection}?tab=blog&item=t1`);
    expect(href('synth', 'done', { paperId: collection })).toBe(`#/collection/${collection}?tab=podcast&item=t1`);
  });

  it('opens the assistant session', () => {
    expect(href('assistant', 'done', { paperId: 'assistant' })).toBe('#/assistant/t1');
    expect(href('assistant', 'done', { paperId: 'assistant', awaitingApproval: true })).toBe('#/assistant/t1');
  });

  it('leaves out the item when a failure left nothing to select', () => {
    expect(href('blog', 'failed')).toBe('#/paper/p1?tab=blog');
    expect(href('script', 'failed')).toBe('#/paper/p1?tab=podcast');
    expect(href('synth', 'failed')).toBe('#/paper/p1?tab=podcast&item=t1');
  });
});

describe('offering notifications', () => {
  const open: OfferContext = { looking: true, supported: true, permission: 'default', on: false, dismissed: false };
  const offer = (context: Partial<OfferContext> = {}, kind: JobKind = 'blog', previous?: Job) =>
    shouldOfferNotifications(previous, job(kind, 'running'), { ...open, ...context });

  it.each(['blog', 'script', 'synth', 'assistant'] as const)('offers when %s starts', (kind) => {
    expect(offer({}, kind)).toBe(true);
  });

  it.each(['chat', 'tags'] as const)('does not offer for %s', (kind) => {
    expect(offer({}, kind)).toBe(false);
  });

  it('only offers when a job first appears', () => {
    expect(offer({}, 'blog', job('blog', 'running'))).toBe(false);
    expect(shouldOfferNotifications(undefined, job('blog', 'done'), open)).toBe(false);
  });

  it('does not offer once decided, dismissed or impossible', () => {
    expect(offer({ dismissed: true })).toBe(false);
    expect(offer({ on: true })).toBe(false);
    expect(offer({ permission: 'granted' })).toBe(false);
    expect(offer({ permission: 'denied' })).toBe(false);
    expect(offer({ supported: false })).toBe(false);
    expect(offer({ looking: false })).toBe(false);
  });
});
