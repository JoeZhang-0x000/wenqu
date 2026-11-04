import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Job, JobKind, ServerEvent } from '../shared/types.js';

const MAX_FINISHED = 60;

export interface JobContext {
  signal: AbortSignal;
  delta(text: string): void;
  /** Clears the streamed text, once it has been saved somewhere else. */
  reset(): void;
  progress(progress: NonNullable<Job['progress']>): void;
}

/** In-memory background tasks. They outlive the browser tab and report over one shared event stream. */
export class Jobs extends EventEmitter {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();

  constructor() {
    super();
    // One listener per open tab, plus one per task being waited on.
    this.setMaxListeners(0);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  isActive(targetId: string): boolean {
    return this.list().some((j) => j.targetId === targetId && j.status === 'running');
  }

  send(event: ServerEvent): void {
    this.emit('event', event);
  }

  start(
    init: { kind: JobKind; paperId: string; label: string; targetId?: string },
    run: (ctx: JobContext) => Promise<void>,
    onFailure?: (message: string, canceled: boolean) => void | Promise<void>,
  ): Job {
    const job: Job = { ...init, id: randomUUID(), status: 'running', text: '', createdAt: new Date().toISOString() };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    this.send({ type: 'job', job: { ...job } });

    const ctx: JobContext = {
      signal: controller.signal,
      delta: (text) => {
        job.text += text;
        this.send({ type: 'delta', jobId: job.id, text });
      },
      reset: () => {
        job.text = '';
        this.send({ type: 'job', job: { ...job } });
      },
      progress: (progress) => {
        job.progress = progress;
        this.send({ type: 'job', job: { ...job } });
      },
    };

    run(ctx)
      .then(() => {
        job.status = 'done';
      })
      .catch(async (err: Error) => {
        const canceled = controller.signal.aborted;
        job.status = canceled ? 'canceled' : 'failed';
        job.error = err.message;
        // An unhandled rejection here would take the whole server down.
        try {
          await onFailure?.(err.message, canceled);
        } catch (failure) {
          console.error(failure);
        }
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.controllers.delete(job.id);
        this.send({ type: 'job', job: { ...job } });
        this.send({ type: 'library' });
        this.prune();
      });
    return { ...job };
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    controller?.abort();
    return Boolean(controller);
  }

  cancelTarget(targetId: string): void {
    for (const job of this.list()) if (job.targetId === targetId && job.status === 'running') this.cancel(job.id);
  }

  /** Resolves once nothing is running for this target, with the last job that ran for it. */
  settled(targetId: string): Promise<Job | undefined> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.isActive(targetId)) return;
        this.off('event', check);
        const ran = this.list().filter((j) => j.targetId === targetId);
        resolve(ran.length ? { ...ran[ran.length - 1] } : undefined);
      };
      this.on('event', check);
      check();
    });
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) this.jobs.delete(job.id);
  }
}
