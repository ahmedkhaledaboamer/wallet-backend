import { isFinalItemStatus } from "../domain/item-status";
import type { Clock } from "../domain/ports/clock";
import type { PayoutGateway, PayoutOutcome } from "../domain/ports/payout-gateway";
import type { PayoutRepository } from "../domain/ports/payout-repository";
import { AuditAction, type AuditLog } from "./audit";
import type { SettleBatch } from "./settle-batch";

export type ProcessResult =
  | { kind: "done"; status: "succeeded" | "failed" | "requires_reconciliation" }
  | { kind: "retry"; reason: string; delayMs?: number }
  | { kind: "skipped"; reason: string };

/**
 * Pays ONE item. Called by the queue worker (jobId = itemId).
 *
 * Exactly-once rules:
 *  1. Claim under a row lock: pending → processing with `sending = true`, committed BEFORE calling the provider.
 *  2. A claim that finds `processing + sending = true` means a previous attempt crashed mid-send:
 *     the outcome is unknown → requires_reconciliation, never re-sent.
 *  3. Only "retryable" outcomes (the request certainly didn't execute) clear `sending` and retry.
 *  4. "unknown" outcomes (timeout after send, 5xx, success without id) → requires_reconciliation, never retried.
 */
export class PayoutItemProcessor {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly gateway: PayoutGateway,
    private readonly settle: SettleBatch,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  async process(itemId: string, attempt: number, maxAttempts: number): Promise<ProcessResult> {
    // 1. Claim
    // Lock order everywhere: batch row first, then item rows (prevents lock-order deadlocks).
    const known = await this.repo.findItem(itemId);
    if (!known) return { kind: "skipped", reason: "item not found" };
    const claim = await this.repo.transaction(async (tx) => {
      const batch = await tx.lockBatch(known.batchId);
      if (!batch || batch.status !== "processing") return { skip: `batch is ${batch?.status ?? "missing"}` } as const;
      const item = await tx.lockItem(itemId);
      if (!item) return { skip: "item not found" } as const;
      if (isFinalItemStatus(item.status)) return { skip: `already ${item.status}` } as const;

      if (item.status === "processing" && item.sending) {
        const reason = "Worker stopped while the withdrawal was being sent; outcome unknown.";
        await tx.updateItem(itemId, { status: "requires_reconciliation", sending: false, failureReason: reason, processedAt: this.clock.now() });
        await this.audit.append(tx, item.batchId, AuditAction.ItemRequiresReconciliation, undefined, { itemId, reference: item.reference, reason });
        await this.settle.ifDone(tx, item.batchId);
        return { skip: "crashed mid-send → reconciliation" } as const;
      }
      await tx.updateItem(itemId, { status: "processing", sending: true, attempts: item.attempts + 1 });
      return { item, batch } as const;
    });
    if ("skip" in claim) return { kind: "skipped", reason: claim.skip! };
    const { item, batch } = claim;

    // 2. Send (outside any DB transaction — never hold a lock across network I/O)
    let outcome: PayoutOutcome;
    try {
      outcome = await this.gateway.send({
        itemId: item.id,
        reference: item.reference,
        address: item.address,
        amount: item.amount,
        asset: batch.asset,
        network: batch.network,
        memo: item.memo,
      });
    } catch (e) {
      // A gateway bug after the request may have left: treat as unknown, never retry.
      outcome = { status: "unknown", reason: `Unexpected gateway error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 3. Record
    const lastAttempt = attempt >= maxAttempts;
    return this.repo.transaction(async (tx) => {
      await tx.lockBatch(item.batchId); // batch first (same order as every other writer)
      const now = this.clock.now();
      switch (outcome.status) {
        case "accepted":
          await tx.updateItem(itemId, {
            status: "succeeded",
            sending: false,
            providerReference: outcome.providerReference,
            txHash: outcome.txHash,
            failureReason: undefined,
            processedAt: now,
          });
          await this.audit.append(tx, item.batchId, AuditAction.ItemSucceeded, undefined, {
            itemId,
            reference: item.reference,
            providerReference: outcome.providerReference,
            gateway: this.gateway.name,
          });
          break;
        case "rejected":
          await tx.updateItem(itemId, { status: "failed", sending: false, failureReason: outcome.reason, processedAt: now });
          await this.audit.append(tx, item.batchId, AuditAction.ItemFailed, undefined, {
            itemId,
            reference: item.reference,
            reason: outcome.reason,
            ...(outcome.providerCode ? { providerCode: outcome.providerCode } : {}),
          });
          break;
        case "unknown":
          await tx.updateItem(itemId, {
            status: "requires_reconciliation",
            sending: false,
            providerReference: outcome.providerReference,
            failureReason: outcome.reason,
            processedAt: now,
          });
          await this.audit.append(tx, item.batchId, AuditAction.ItemRequiresReconciliation, undefined, {
            itemId,
            reference: item.reference,
            reason: outcome.reason,
          });
          break;
        case "retryable":
          if (!lastAttempt) {
            await tx.updateItem(itemId, { sending: false, failureReason: outcome.reason });
            await this.audit.append(tx, item.batchId, AuditAction.ItemRetryScheduled, undefined, {
              itemId,
              reference: item.reference,
              attempt,
              reason: outcome.reason,
            });
            return { kind: "retry", reason: outcome.reason, delayMs: outcome.retryAfterMs } satisfies ProcessResult;
          }
          // Retries exhausted, and the request never executed → safe to mark failed.
          await tx.updateItem(itemId, {
            status: "failed",
            sending: false,
            failureReason: `Provider unreachable after ${attempt} attempts: ${outcome.reason}`,
            processedAt: now,
          });
          await this.audit.append(tx, item.batchId, AuditAction.ItemFailed, undefined, { itemId, reference: item.reference, reason: outcome.reason, attempts: attempt });
          break;
      }
      await this.settle.ifDone(tx, item.batchId);
      const status = outcome.status === "accepted" ? "succeeded" : outcome.status === "unknown" ? "requires_reconciliation" : "failed";
      return { kind: "done", status } satisfies ProcessResult;
    });
  }
}
