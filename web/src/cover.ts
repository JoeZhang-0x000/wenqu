import type { CoverPlan, PaperSummary } from '../../src/shared/types';
import { api } from './lib';
import { renderFigureCover, renderPageCover } from './pdf';

interface Job {
  /** Cards that are on screen and waiting for this cover. */
  viewers: Set<(url: string) => void>;
}

const jobs = new Map<string, Job>();
/** Couldn't reach a settled result, which is worth trying again only after the next page load. */
const gaveUp = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

const thumbUrl = (paperId: string, stamp: number) => `/api/papers/${paperId}/thumb?v=${stamp}`;

export const coverUrl = (paper: PaperSummary): string | undefined => (paper.hasThumb ? thumbUrl(paper.id, paper.thumbStamp) : undefined);

/** Works down the plan, ending with page 1, so that one bad step doesn't cost the card its cover. */
async function draw(paperId: string, figure: string | undefined, page: number) {
  const attempts: { kind: 'figure' | 'page'; page: number; render(): Promise<Blob> }[] = [];
  if (figure) attempts.push({ kind: 'figure', page, render: () => renderFigureCover(paperId, figure) });
  attempts.push({ kind: 'page', page, render: () => renderPageCover(paperId, page) });
  if (page !== 1) attempts.push({ kind: 'page', page: 1, render: () => renderPageCover(paperId, 1) });
  for (const attempt of attempts) {
    try {
      return { ...attempt, blob: await attempt.render() };
    } catch {
      /* On to the next one. */
    }
  }
  return null;
}

async function refresh(paperId: string): Promise<string | undefined> {
  const plan = await api<CoverPlan>(`/papers/${paperId}/cover`);
  if (plan.settled) return plan.thumbStamp ? thumbUrl(paperId, plan.thumbStamp) : undefined;
  const drawn = await draw(paperId, plan.figure, plan.page);
  if (!drawn) {
    await api(`/papers/${paperId}/cover/failed`, { method: 'POST' });
    return undefined;
  }
  try {
    const { thumbStamp } = await api<{ thumbStamp: number }>(`/papers/${paperId}/thumb?kind=${drawn.kind}&page=${drawn.page}`, {
      method: 'PUT',
      raw: drawn.blob,
    });
    return thumbUrl(paperId, thumbStamp);
  } catch {
    // Not saved, so it's generated again after the next load. This view still gets its cover.
    gaveUp.add(paperId);
    return URL.createObjectURL(drawn.blob);
  }
}

/**
 * Asks for a paper's cover to be brought up to date while its card is on screen. Returns how to stop asking.
 * This runs one paper at a time, and a card scrolled away before its turn is skipped until it's seen again.
 */
export function requestCover(paperId: string, onReady: (url: string) => void): () => void {
  if (gaveUp.has(paperId)) return () => {};
  let job = jobs.get(paperId);
  if (!job) {
    const created: Job = { viewers: new Set() };
    job = created;
    jobs.set(paperId, created);
    const run = async () => {
      if (!created.viewers.size) {
        jobs.delete(paperId);
        return;
      }
      try {
        const url = await refresh(paperId);
        if (url) created.viewers.forEach((notify) => notify(url));
      } catch {
        // The card keeps what it shows.
        gaveUp.add(paperId);
      } finally {
        jobs.delete(paperId);
      }
    };
    queue = queue.then(run, run);
  }
  job.viewers.add(onReady);
  const { viewers } = job;
  return () => viewers.delete(onReady);
}
