import type { ConfirmOnchainBatch } from "../../application/confirm-onchain-batch";
import type { PayoutItemProcessor } from "../../application/payout-item-processor";

export const PAY_ITEM_QUEUE = "payout-items";
export const VERIFY_TX_QUEUE = "tx-verification";

export interface PayItemJob {
  batchId: string;
  itemId: string;
}
export interface VerifyTxJob {
  batchId: string;
  txHash: string;
}

/** Thrown to make the queue retry with backoff (only for "retryable" gateway outcomes). */
export class RetryLaterError extends Error {
  constructor(
    reason: string,
    readonly delayMs?: number,
  ) {
    super(reason);
    this.name = "RetryLaterError";
  }
}

/** Queue-agnostic job handlers: BullMQ and the in-memory queue both call these. */
export interface JobHandlers {
  payItem(job: PayItemJob, attempt: number, maxAttempts: number): Promise<void>;
  /** Returns a delay to poll again, or undefined when verification is final. */
  verifyTx(job: VerifyTxJob): Promise<number | undefined>;
}

export function createJobHandlers(processor: PayoutItemProcessor, confirm: ConfirmOnchainBatch): JobHandlers {
  return {
    async payItem(job, attempt, maxAttempts) {
      const r = await processor.process(job.itemId, attempt, maxAttempts);
      if (r.kind === "retry") throw new RetryLaterError(r.reason, r.delayMs);
    },
    async verifyTx(job) {
      const r = await confirm.process(job.batchId, job.txHash);
      return r.kind === "poll_again" ? r.delayMs : undefined;
    },
  };
}
