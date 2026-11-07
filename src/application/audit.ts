import type { Clock } from "../domain/ports/clock";
import type { IdGenerator } from "../domain/ports/id-generator";
import type { PayoutRepositoryTx } from "../domain/ports/payout-repository";

/** Audit action names (also used by the frontend for labels). */
export const AuditAction = {
  BatchCreated: "batch.created",
  BatchApproved: "batch.approved",
  BatchRejected: "batch.rejected",
  ExecutionStarted: "batch.execution_started",
  TransactionSubmitted: "batch.transaction_submitted",
  TransactionVerified: "batch.transaction_verified",
  BatchCompleted: "batch.completed",
  BatchCompletedWithIssues: "batch.completed_with_issues",
  BatchFailed: "batch.failed",
  ItemSucceeded: "item.succeeded",
  ItemFailed: "item.failed",
  ItemRequiresReconciliation: "item.requires_reconciliation",
  ItemRetryScheduled: "item.retry_scheduled",
} as const;

export class AuditLog {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Append-only: entries are only ever inserted (the DB rejects UPDATE/DELETE). */
  append(tx: PayoutRepositoryTx, batchId: string, action: string, actorId: string | undefined, context: Record<string, unknown> = {}) {
    return tx.appendAudit({ id: this.ids.auditId(), batchId, action, actorId, context, createdAt: this.clock.now() });
  }
}
