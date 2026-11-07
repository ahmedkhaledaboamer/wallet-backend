import { assertBatchTransition } from "../domain/batch-status";
import type { Clock } from "../domain/ports/clock";
import type { PayoutQueue } from "../domain/ports/payout-queue";
import type { BatchRecord, PayoutRepository, UserRecord } from "../domain/ports/payout-repository";
import { AuditAction, type AuditLog } from "./audit";
import { assertChannel, assertRole, requireBatch } from "./authorize";

export class ExecuteBatch {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly queue: PayoutQueue,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly gatewayName: string,
  ) {}

  /**
   * approved → processing EXACTLY once: the status check happens under SELECT … FOR UPDATE,
   * so a double click (or two executors) gets 409 for every call but the first.
   * One job per item is enqueued after commit (jobId = itemId → enqueueing twice is a no-op).
   */
  async execute(actor: UserRecord, batchId: string): Promise<BatchRecord> {
    assertRole(actor, "executor");
    await this.repo.transaction(async (tx) => {
      const batch = requireBatch(await tx.lockBatch(batchId), batchId);
      assertChannel(batch, "mexc", "Trust Wallet batches are paid by signing in the wallet, not by /execute.");
      assertBatchTransition(batchId, batch.status, "processing");
      await tx.updateBatch(batchId, { status: "processing", executedById: actor.id, executedAt: this.clock.now() });
      await this.audit.append(tx, batchId, AuditAction.ExecutionStarted, actor.id, {
        provider: this.gatewayName,
        itemCount: batch.itemCount,
        totalAmount: batch.totalAmount.toString(),
      });
    });
    const items = await this.repo.allItems(batchId);
    await this.queue.enqueueItems(
      batchId,
      items.filter((i) => i.status === "pending").map((i) => i.id),
    );
    return (await this.repo.findBatch(batchId))!;
  }
}

/** Safety net run at worker start: re-enqueue pending items of processing MEXC batches (idempotent by jobId). */
export class RequeuePendingItems {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly queue: PayoutQueue,
  ) {}

  async run(): Promise<number> {
    let total = 0;
    for (let page = 1; ; page++) {
      const { data } = await this.repo.listBatches({ status: "processing", channel: "mexc", page, pageSize: 100 });
      for (const b of data) {
        const pending = (await this.repo.allItems(b.id)).filter((i) => i.status === "pending" || (i.status === "processing" && !i.sending));
        if (pending.length) await this.queue.enqueueItems(b.id, pending.map((i) => i.id));
        total += pending.length;
      }
      if (data.length < 100) return total;
    }
  }
}
