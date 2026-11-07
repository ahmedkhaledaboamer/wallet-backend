import { assertBatchTransition } from "../domain/batch-status";
import { PolicyViolationError, ValidationError } from "../domain/errors";
import type { Clock } from "../domain/ports/clock";
import type { BatchRecord, PayoutRepository, UserRecord } from "../domain/ports/payout-repository";
import { AuditAction, type AuditLog } from "./audit";
import { assertRole, requireBatch } from "./authorize";
import type { AppSettings } from "./settings";

export class ReviewBatch {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly settings: AppSettings,
  ) {}

  /** draft → approved, under a row lock. Four-eyes: the uploader can never approve their own batch. */
  async approve(actor: UserRecord, batchId: string): Promise<BatchRecord> {
    assertRole(actor, "checker");
    await this.repo.transaction(async (tx) => {
      const batch = requireBatch(await tx.lockBatch(batchId), batchId);
      if (batch.createdBy.id === actor.id) {
        throw new PolicyViolationError("FOUR_EYES", "The maker of a batch cannot approve it.");
      }
      assertBatchTransition(batchId, batch.status, "approved");
      if (batch.totalAmount.gt(this.settings.maxBatchTotal)) {
        throw new PolicyViolationError("BATCH_TOTAL_LIMIT", `Batch total exceeds the limit of ${this.settings.maxBatchTotal.toString()}.`);
      }
      const now = this.clock.now();
      await tx.updateBatch(batchId, { status: "approved", approvedById: actor.id, approvedAt: now });
      await this.audit.append(tx, batchId, AuditAction.BatchApproved, actor.id, { totalAmount: batch.totalAmount.toString(), itemCount: batch.itemCount });
    });
    return (await this.repo.findBatch(batchId))!;
  }

  /** draft → rejected with a mandatory reason. Rejection frees the file hash for a corrected re-upload. */
  async reject(actor: UserRecord, batchId: string, reason: unknown): Promise<BatchRecord> {
    assertRole(actor, "checker");
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text.length < 5 || text.length > 1000) {
      throw new ValidationError("A rejection reason of 5–1000 characters is required.", [], "REASON_REQUIRED");
    }
    await this.repo.transaction(async (tx) => {
      const batch = requireBatch(await tx.lockBatch(batchId), batchId);
      if (batch.createdBy.id === actor.id) {
        throw new PolicyViolationError("FOUR_EYES", "The maker of a batch cannot review it.");
      }
      assertBatchTransition(batchId, batch.status, "rejected");
      // The reviewer is recorded in the audit log; approvedBy stays empty (nothing was approved).
      await tx.updateBatch(batchId, { status: "rejected", rejectionReason: text });
      await this.audit.append(tx, batchId, AuditAction.BatchRejected, actor.id, { reason: text });
    });
    return (await this.repo.findBatch(batchId))!;
  }
}
