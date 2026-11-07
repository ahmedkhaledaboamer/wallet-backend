import { Logger } from "@nestjs/common";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PayoutQueue } from "../../domain/ports/payout-queue";
import { PAY_ITEM_QUEUE, RetryLaterError, VERIFY_TX_QUEUE, type JobHandlers, type PayItemJob, type VerifyTxJob } from "./job-handlers";

export interface BullOptions {
  redisUrl: string;
  maxAttempts: number;
  backoffMs: number;
  ratePerSecond: number;
  concurrency: number;
}

const connection = (url: string): ConnectionOptions => ({ url, maxRetriesPerRequest: null });

/** Producer side (API process). */
export class BullMqPayoutQueue implements PayoutQueue {
  private readonly items: Queue<PayItemJob>;
  private readonly verify: Queue<VerifyTxJob>;

  constructor(private readonly opts: BullOptions) {
    this.items = new Queue<PayItemJob>(PAY_ITEM_QUEUE, { connection: connection(opts.redisUrl) });
    this.verify = new Queue<VerifyTxJob>(VERIFY_TX_QUEUE, { connection: connection(opts.redisUrl) });
  }

  async enqueueItems(batchId: string, itemIds: string[]): Promise<void> {
    await this.items.addBulk(
      itemIds.map((itemId) => ({
        name: "pay-item",
        data: { batchId, itemId },
        opts: {
          jobId: itemId, // idempotent: the same item can never be enqueued twice
          attempts: this.opts.maxAttempts,
          backoff: { type: "exponential", delay: this.opts.backoffMs },
          removeOnComplete: { age: 7 * 24 * 3600 },
          removeOnFail: { age: 30 * 24 * 3600 },
        },
      })),
    );
  }

  async enqueueVerification(batchId: string, txHash: string, delayMs = 0): Promise<void> {
    await this.verify.add(
      "verify-tx",
      { batchId, txHash },
      { jobId: `verify-${batchId}-${txHash}`, delay: delayMs, attempts: 10, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: true },
    );
  }

  async close() {
    await Promise.all([this.items.close(), this.verify.close()]);
  }
}

/** Consumer side (worker process). */
export class BullMqWorkers {
  private readonly logger = new Logger("Worker");
  private readonly workers: Worker[] = [];
  private readonly verifyQueue: Queue<VerifyTxJob>;

  constructor(
    private readonly opts: BullOptions,
    private readonly handlers: JobHandlers,
  ) {
    this.verifyQueue = new Queue<VerifyTxJob>(VERIFY_TX_QUEUE, { connection: connection(opts.redisUrl) });
  }

  start() {
    const payItems = new Worker<PayItemJob>(
      PAY_ITEM_QUEUE,
      async (job: Job<PayItemJob>) => {
        const attempt = job.attemptsMade + 1;
        try {
          await this.handlers.payItem(job.data, attempt, this.opts.maxAttempts);
        } catch (e) {
          if (e instanceof RetryLaterError) this.logger.warn(`item ${job.data.itemId} attempt ${attempt} → retry: ${e.message}`);
          throw e; // BullMQ applies the exponential backoff
        }
      },
      {
        connection: connection(this.opts.redisUrl),
        concurrency: this.opts.concurrency,
        limiter: { max: Math.max(1, this.opts.ratePerSecond), duration: 1000 }, // provider rate limit
      },
    );

    const verify = new Worker<VerifyTxJob>(
      VERIFY_TX_QUEUE,
      async (job: Job<VerifyTxJob>) => {
        const again = await this.handlers.verifyTx(job.data);
        if (again !== undefined) {
          // Poll again later as a fresh delayed job (unique id per poll).
          await this.verifyQueue.add("verify-tx", job.data, {
            jobId: `verify-${job.data.batchId}-${job.data.txHash}-${Date.now()}`,
            delay: again,
            attempts: 10,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: true,
          });
        }
      },
      { connection: connection(this.opts.redisUrl), concurrency: 2 },
    );

    for (const w of [payItems, verify]) {
      w.on("failed", (job, err) => this.logger.error(`${w.name} job ${job?.id} failed: ${err.message}`));
      w.on("error", (err) => this.logger.error(`${w.name}: ${err.message}`));
      this.workers.push(w);
    }
    this.logger.log(`Workers started (rate limit ${this.opts.ratePerSecond}/s, concurrency ${this.opts.concurrency})`);
  }

  async close() {
    await Promise.all([...this.workers.map((w) => w.close()), this.verifyQueue.close()]);
  }
}
