import { t } from '../../src/shared/i18n';
import type { Job, JobKind } from '../../src/shared/types';
import { ownerHref, type Route } from './routes';

/** Kinds worth telling the user about, with the tab that shows the result. Chat replies and tags have no place here. */
const ANNOUNCED: Partial<Record<JobKind, { tab?: 'blog' | 'podcast' }>> = {
  blog: { tab: 'blog' },
  script: { tab: 'podcast' },
  synth: { tab: 'podcast' },
  assistant: {},
};

export interface NoticeContext {
  /** The page is visible and its window has focus. */
  looking: boolean;
  /** Notifications are enabled and the browser allows them. */
  notificationsOn: boolean;
  route: Route;
  /** Jobs this page has already announced. */
  announced: ReadonlySet<string>;
}

export interface JobNotice {
  via: 'system' | 'toast' | 'none';
  title: string;
  body: string;
  href: string;
  /** Tabs share it, so the browser shows one notification however many are open. */
  tag: string;
  failed: boolean;
}

function title(job: Job): string {
  const failed = job.status === 'failed';
  switch (job.kind) {
    case 'blog':
      return failed ? t('博客生成失败') : t('博客已生成');
    case 'script':
      return failed ? t('播客脚本生成失败') : t('播客脚本已生成');
    case 'synth':
      return failed ? t('播客音频合成失败') : t('播客音频已合成');
    default:
      return failed ? t('助手运行失败') : job.awaitingApproval ? t('助手需要你批准') : t('助手已回复');
  }
}

function resultHref(job: Job): string {
  if (job.kind === 'assistant') return job.targetId ? `#/assistant/${job.targetId}` : '#/assistant';
  // A failed post or script leaves nothing behind to select. A failed synthesis keeps its episode.
  const item = job.status === 'done' || job.kind === 'synth' ? job.targetId : undefined;
  return ownerHref(job.paperId, ANNOUNCED[job.kind]?.tab, item);
}

function showsResult(route: Route, job: Job): boolean {
  if (job.kind === 'assistant') return route.page === 'assistant' && route.id === job.targetId;
  return (route.page === 'paper' || route.page === 'collection') && route.id === job.paperId && route.tab === ANNOUNCED[job.kind]?.tab;
}

/**
 * What to do about a job's latest state, or null when it has nothing to announce.
 * Only running → finished counts. A connect lists jobs this page never saw running, so they stay quiet.
 */
export function decideJobNotice(previous: Job | undefined, job: Job, context: NoticeContext): JobNotice | null {
  if (!ANNOUNCED[job.kind] || previous?.status !== 'running') return null;
  if ((job.status !== 'done' && job.status !== 'failed') || context.announced.has(job.id)) return null;
  const failed = job.status === 'failed';
  // A generation panel only shows a failure it started itself, while a conversation always shows its own error.
  const quietHere = showsResult(context.route, job) && (!failed || job.kind === 'assistant');
  const via = context.looking ? (quietHere ? 'none' : 'toast') : context.notificationsOn ? 'system' : 'none';
  return { via, title: title(job), body: job.label, href: resultHref(job), tag: `wenqu-job-${job.id}`, failed };
}

export interface OfferContext {
  looking: boolean;
  supported: boolean;
  permission: NotificationPermission;
  on: boolean;
  dismissed: boolean;
}

/** The moment to offer notifications: a task the user would wait for has just started, and they haven't decided yet. */
export function shouldOfferNotifications(previous: Job | undefined, job: Job, context: OfferContext): boolean {
  return (
    Boolean(ANNOUNCED[job.kind]) &&
    !previous &&
    job.status === 'running' &&
    context.looking &&
    context.supported &&
    context.permission === 'default' &&
    !context.on &&
    !context.dismissed
  );
}
