import { t } from '../../src/shared/i18n';
import type { Job } from '../../src/shared/types';
import { decideJobNotice, shouldOfferNotifications, type JobNotice } from './jobNotice';
import { createStore, currentRoute, goTo, toast } from './lib';

const ON_KEY = 'wenqu-notifications';
const DISMISSED_KEY = 'wenqu-notifications-offer-dismissed';
/** Long enough for a tab the user is looking at to speak up, too short to notice. */
const CLAIM_WAIT_MS = 200;

type Support = 'ok' | 'unsupported' | 'insecure';

export interface NotificationState {
  support: Support;
  permission: NotificationPermission;
  /** Enabled here and allowed by the browser. */
  on: boolean;
}

function readFlag(key: string): boolean | undefined {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return undefined;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* Then it lasts until the page reloads. */
  }
}

const support = (): Support => (!isSecureContext ? 'insecure' : typeof Notification === 'undefined' ? 'unsupported' : 'ok');
const permission = (): NotificationPermission => (support() === 'ok' ? Notification.permission : 'denied');

let enabled = readFlag(ON_KEY) ?? false;
let dismissed = readFlag(DISMISSED_KEY) ?? false;

const readState = (): NotificationState => ({ support: support(), permission: permission(), on: enabled && permission() === 'granted' });

export const notificationsStore = createStore<NotificationState>(readState());
export const notificationOfferStore = createStore(false);

/** The flags can change in another tab, and the permission in the browser's own settings. */
function refresh(): void {
  enabled = readFlag(ON_KEY) ?? enabled;
  dismissed = readFlag(DISMISSED_KEY) ?? dismissed;
  const before = notificationsStore.get();
  const next = readState();
  if (before.support !== next.support || before.permission !== next.permission || before.on !== next.on) notificationsStore.set(next);
  if (dismissed && notificationOfferStore.get()) notificationOfferStore.set(false);
}
window.addEventListener('focus', refresh);
window.addEventListener('storage', refresh);

/** Call only from a click: browsers ignore or penalize permission requests without one. */
export async function setNotificationsOn(next: boolean): Promise<void> {
  const allowed = next && (Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission) === 'granted';
  enabled = allowed;
  writeFlag(ON_KEY, allowed);
  refresh();
}

export function dismissNotificationOffer(): void {
  dismissed = true;
  writeFlag(DISMISSED_KEY, true);
  notificationOfferStore.set(false);
}

export async function acceptNotificationOffer(): Promise<void> {
  dismissNotificationOffer();
  await setNotificationsOn(true);
  if (notificationsStore.get().on) toast(t('通知已打开。可以在“设置 → 通用”里关闭'));
}

// A hidden tab can't see that the user is looking at another one, so that tab tells it.
const claimed = new Set<string>();
let channel: BroadcastChannel | undefined;
try {
  channel = new BroadcastChannel('wenqu-notifications');
  channel.onmessage = (e) => claimed.add(e.data as string);
} catch {
  /* Then a hidden tab may notify while another tab is in view. */
}

// Keeps each one reachable, so its click handler can't be collected while it's still on screen.
const showing = new Set<Notification>();

function showSystemNotification(jobId: string, notice: JobNotice): void {
  setTimeout(() => {
    if (claimed.has(jobId)) return;
    try {
      const notification = new Notification(notice.title, { body: notice.body, tag: notice.tag });
      showing.add(notification);
      notification.onclose = () => showing.delete(notification);
      notification.onclick = () => {
        window.focus();
        goTo(notice.href);
        notification.close();
      };
    } catch {
      /* Android browsers only allow notifications from a service worker. */
    }
  }, CLAIM_WAIT_MS);
}

const announced = new Set<string>();

export function observeJob(previous: Job | undefined, job: Job, live: boolean): void {
  refresh();
  const looking = document.visibilityState === 'visible' && document.hasFocus();
  if (live && shouldOfferNotifications(previous, job, { looking, supported: support() === 'ok', permission: permission(), on: notificationsStore.get().on, dismissed })) {
    notificationOfferStore.set(true);
  }
  const notice = decideJobNotice(previous, job, { looking, notificationsOn: notificationsStore.get().on, route: currentRoute(), announced });
  if (!notice) return;
  announced.add(job.id);
  if (looking) channel?.postMessage(job.id);
  if (notice.via === 'toast') toast(`${notice.title} · ${notice.body}`, notice.failed ? 'error' : 'info');
  else if (notice.via === 'system') showSystemNotification(job.id, notice);
}
