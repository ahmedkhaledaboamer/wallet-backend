import { settledBatchStatus } from "../domain/batch-status";
import type { Clock } from "../domain/ports/clock";
import type { PayoutRepositoryTx } from "../domain/ports/payout-repository";
import { AuditAction, type AuditLog } from "./audit";

const ACTION_FOR = {
  completed: AuditAction.BatchCompleted,
  completed_with_issues: AuditAction.BatchCompletedWithIssues,
  failed: AuditAction.BatchFailed,
} as const;

/**
 * Settles a processing batch once no item is in flight. MUST run inside a
 * transaction that holds the batch row lock, so two workers finishing the last
 * two items can't both settle (or settle too early).
 */
export class SettleBatch {
  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  async ifDone(tx: PayoutRepositoryTx, batchId: string): Promise<boolean> {
    const batch = await tx.lockBatch(batchId);
    if (!batch || batch.status !== "processing") return false;
    const c = await tx.countItemsByStatus(batchId);
    const counts = { paidCount: c.succeeded, failedCount: c.failed, reconciliationCount: c.requires_reconciliation };
    if (c.pending + c.processing > 0) {
      await tx.updateBatch(batchId, counts); // keep progress counters fresh for polling clients
      return false;
    }
    const status = settledBatchStatus({ itemCount: batch.itemCount, succeeded: c.succeeded, failed: c.failed, reconciliation: c.requires_reconciliation });
    await tx.updateBatch(batchId, { status, ...counts, completedAt: this.clock.now() });
    await this.audit.append(tx, batchId, ACTION_FOR[status as keyof typeof ACTION_FOR], undefined, {
      paidCount: c.succeeded,
      failedCount: c.failed,
      reconciliationCount: c.requires_reconciliation,
      ...(batch.simulated ? { simulated: true } : {}),
    });
    return true;
  }
}
