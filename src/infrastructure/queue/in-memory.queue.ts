import type { PayoutQueue } from "../../domain/ports/payout-queue";
import { RetryLaterError, type JobHandlers } from "./job-handlers";

export interface InMemoryQueueOptions {
  maxAttempts: number;
  /** Base backoff in ms (exponential: base * 2^(attempt-1)). */
  backoffMs: number;
  concurrency: number;
}

/**
 * Same semantics as the BullMQ adapter (jobId dedupe, retries with exponential
 * backoff, delayed verification polls), in-process. Used by tests and by
 * QUEUE_DRIVER=memory for a Redis-less local run.
 */
export class InMemoryPayoutQueue implements PayoutQueue {
  private handlers?: JobHandlers;
  private readonly known = new Set<string>();
  private readonly waiting: (() => Promise<void>)[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private running = 0;
  private scheduled = 0;
  private idleResolvers: (() => void)[] = [];
  private closed = false;
  readonly errors: unknown[] = [];

  constructor(private readonly opts: InMemoryQueueOptions = { maxAttempts: 5, backoffMs: 1000, concurrency: 2 }) {}

  attach(handlers: JobHandlers) {
    this.handlers = handlers;
  }

  async enqueueItems(batchId: string, itemIds: string[]): Promise<void> {
    for (const itemId of itemIds) {
      if (this.known.has(itemId)) continue; // jobId = itemId
      this.known.add(itemId);
      this.push(() => this.runPayItem(batchId, itemId, 1));
    }
  }

  async enqueueVerification(batchId: string, txHash: string, delayMs = 0): Promise<void> {
    this.later(delayMs, () => this.runVerify(batchId, txHash));
  }

  /** Resolves when no job is running, queued or scheduled (tests). */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private isIdle() {
    return this.running === 0 && this.waiting.length === 0 && this.scheduled === 0;
  }

  private later(delayMs: number, job: () => Promise<void>) {
    if (this.closed) return;
    this.scheduled++;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.scheduled--;
      this.push(job);
    }, delayMs);
    this.timers.add(t);
  }

  private push(job: () => Promise<void>) {
    if (this.closed) return;
    this.waiting.push(job);
    this.pump();
  }

  private pump() {
    while (this.running < this.opts.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      void job()
        .catch((e) => this.errors.push(e))
        .finally(() => {
          this.running--;
          this.pump();
          if (this.isIdle()) this.idleResolvers.splice(0).forEach((r) => r());
        });
    }
  }

  private async runPayItem(batchId: string, itemId: string, attempt: number): Promise<void> {
    if (!this.handlers) throw new Error("InMemoryPayoutQueue: no handlers attached");
    try {
      await this.handlers.payItem({ batchId, itemId }, attempt, this.opts.maxAttempts);
    } catch (e) {
      if (e instanceof RetryLaterError && attempt < this.opts.maxAttempts) {
        const delay = e.delayMs ?? this.opts.backoffMs * 2 ** (attempt - 1);
        this.later(delay, () => this.runPayItem(batchId, itemId, attempt + 1));
        return;
      }
      throw e;
    }
  }

  private async runVerify(batchId: string, txHash: string): Promise<void> {
    if (!this.handlers) throw new Error("InMemoryPayoutQueue: no handlers attached");
    const again = await this.handlers.verifyTx({ batchId, txHash });
    if (again !== undefined) this.later(again, () => this.runVerify(batchId, txHash));
  }
}
