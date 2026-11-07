import { uuidToBatchRef } from "../domain/batch-ref";
import { assertBatchTransition } from "../domain/batch-status";
import { ValidationError } from "../domain/errors";
import type { Clock } from "../domain/ports/clock";
import type { PayoutQueue } from "../domain/ports/payout-queue";
import type { BatchRecord, PayoutRepository, UserRecord } from "../domain/ports/payout-repository";
import type { TransactionVerifier, VerificationResult } from "../domain/ports/transaction-verifier";
import { AuditAction, type AuditLog } from "./audit";
import { assertChannel, assertRole, requireBatch } from "./authorize";
import { onchainNetworkFor } from "./prepare-onchain-batch";
import type { SettleBatch } from "./settle-batch";
import type { AppSettings } from "./settings";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type VerifyStep = { kind: "done"; result: VerificationResult["status"] } | { kind: "poll_again"; delayMs: number };

export class ConfirmOnchainBatch {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly queue: PayoutQueue,
    private readonly verifier: TransactionVerifier,
    private readonly settle: SettleBatch,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly settings: AppSettings,
  ) {}

  /** POST /transaction: approved → processing exactly once, then verification is queued. */
  async submit(actor: UserRecord, batchId: string, txHash: unknown): Promise<BatchRecord> {
    assertRole(actor, "executor");
    if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
      throw new ValidationError("txHash must be a 0x-prefixed 32-byte hex string.", [], "INVALID_TX_HASH");
    }
    const hash = txHash.toLowerCase();
    await this.repo.transaction(async (tx) => {
      const batch = requireBatch(await tx.lockBatch(batchId), batchId);
      assertChannel(batch, "trust_wallet", "Only Trust Wallet batches accept a transaction hash.");
      assertBatchTransition(batchId, batch.status, "processing");
      const net = onchainNetworkFor(this.settings, batch.network);
      const simulated = this.verifier.isSimulated(net.chainId);
      const now = this.clock.now();
      await tx.updateBatch(batchId, { status: "processing", txHash: hash, executedById: actor.id, executedAt: now, simulated });
      await tx.updateItemsByBatch(batchId, "pending", { status: "processing", txHash: hash });
      await this.audit.append(tx, batchId, AuditAction.TransactionSubmitted, actor.id, {
        txHash: hash,
        chainId: net.chainId,
        treasury: net.treasury,
        ...(simulated ? { simulated: true } : {}),
      });
    });
    await this.queue.enqueueVerification(batchId, hash, 0);
    return (await this.repo.findBatch(batchId))!;
  }

  /** One verification poll (queue job). Re-schedules itself until final or timed out. */
  async process(batchId: string, txHash: string): Promise<VerifyStep> {
    const batch = await this.repo.findBatch(batchId);
    if (!batch || batch.status !== "processing" || batch.txHash !== txHash.toLowerCase()) {
      return { kind: "done", result: "not_found" };
    }
    const net = onchainNetworkFor(this.settings, batch.network);
    const items = await this.repo.allItems(batchId);
    const result = await this.verifier.verify({
      txHash: batch.txHash as `0x${string}`,
      chainId: net.chainId,
      treasury: net.treasury,
      contract: net.contract,
      token: net.token,
      batchRef: uuidToBatchRef(batch.id),
      totalUnits: batch.totalAmount.toBaseUnits(net.tokenDecimals),
      count: items.length,
    });

    if (result.status === "pending" || result.status === "not_found") {
      const waited = this.clock.now().getTime() - (batch.executedAt?.getTime() ?? 0);
      if (waited < this.settings.verifyTimeoutMs) return { kind: "poll_again", delayMs: this.settings.verifyPollMs };
      // Never saw enough confirmations in time: we can't know if it paid → humans reconcile.
      await this.finish(batch, "requires_reconciliation", `Transaction not confirmed within ${Math.round(this.settings.verifyTimeoutMs / 60000)} min (${result.status}).`, result);
      return { kind: "done", result: result.status };
    }

    if (result.status === "confirmed") await this.finish(batch, "succeeded", undefined, result);
    else if (result.status === "reverted") await this.finish(batch, "failed", "Transaction reverted on-chain; no funds moved.", result);
    else await this.finish(batch, "requires_reconciliation", `On-chain transaction does not match the batch: ${result.reason}`, result);
    return { kind: "done", result: result.status };
  }

  private async finish(batch: BatchRecord, status: "succeeded" | "failed" | "requires_reconciliation", reason: string | undefined, result: VerificationResult) {
    await this.repo.transaction(async (tx) => {
      const locked = await tx.lockBatch(batch.id);
      if (!locked || locked.status !== "processing") return; // another poll already finished it
      const now = this.clock.now();
      await tx.updateItemsByBatch(batch.id, "processing", {
        status,
        providerReference: batch.txHash,
        failureReason: reason,
        processedAt: now,
      });
      await this.audit.append(tx, batch.id, AuditAction.TransactionVerified, undefined, {
        txHash: batch.txHash,
        result: result.status,
        ...("blockNumber" in result ? { blockNumber: result.blockNumber.toString() } : {}),
        ...(reason ? { reason } : {}),
        ...(batch.simulated ? { simulated: true } : {}),
      });
      await this.settle.ifDone(tx, batch.id);
    });
  }
}
