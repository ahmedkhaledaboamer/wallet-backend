export interface PayoutQueue {
  /** One job per item; jobId = itemId so a double enqueue is a no-op. */
  enqueueItems(batchId: string, itemIds: string[]): Promise<void>;
  /** Schedules on-chain verification of a submitted transaction. */
  enqueueVerification(batchId: string, txHash: string, delayMs?: number): Promise<void>;
}
export const PAYOUT_QUEUE = Symbol("PayoutQueue");
