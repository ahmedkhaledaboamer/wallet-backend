import { ValidationError } from "../domain/errors";
import { fileError } from "../domain/withdrawal-rules";
import type { Channel } from "../domain/network";
import type { Clock } from "../domain/ports/clock";
import type { IdGenerator } from "../domain/ports/id-generator";
import type { BatchRecord, PayoutRepository, UserRecord } from "../domain/ports/payout-repository";
import { assertRole } from "./authorize";
import { AuditAction, type AuditLog } from "./audit";
import type { UploadedFile, ValidateWithdrawalSheet } from "./validate-withdrawal-sheet";

/** Thrown by the repository when the partial unique index on file_sha256 fires. */
export class DuplicateFileError extends Error {
  constructor(readonly existingBatchId?: string) {
    super("Duplicate file");
  }
}

export class ImportWithdrawalSheet {
  constructor(
    private readonly validate: ValidateWithdrawalSheet,
    private readonly repo: PayoutRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  /** All-or-nothing: either every row becomes an item of a new draft batch, or nothing is stored (422). */
  async execute(actor: UserRecord, file: UploadedFile, channel: Channel): Promise<BatchRecord> {
    assertRole(actor, "maker");
    const v = await this.validate.execute(file, channel);
    if (!v.valid || !v.network || !v.asset) {
      throw new ValidationError("The withdrawal list has validation errors.", v.errors);
    }

    const id = this.ids.batchId();
    const now = this.clock.now();
    try {
      await this.repo.transaction(async (tx) => {
        await tx.insertBatch({
          id,
          channel,
          asset: v.asset!,
          network: v.network!,
          totalAmount: v.totalAmount,
          fileSha256: v.sha256,
          fileName: file.name,
          createdById: actor.id,
          createdAt: now,
          items: v.withdrawals.map((w) => ({
            id: this.ids.itemId(),
            rowNumber: w.row,
            reference: w.reference,
            address: w.address,
            amount: w.amount,
            memo: w.memo,
          })),
        });
        await this.audit.append(tx, id, AuditAction.BatchCreated, actor.id, {
          fileName: file.name,
          fileSha256: v.sha256,
          rowCount: v.rowCount,
          totalAmount: v.totalAmount.toString(),
          channel,
          network: v.network,
          asset: v.asset,
        });
      });
    } catch (e) {
      // Race: the same file was imported concurrently and won the unique index.
      if (e instanceof DuplicateFileError) {
        throw new ValidationError("The withdrawal list has validation errors.", [fileError("file.duplicate", { batchId: e.existingBatchId ?? "" })]);
      }
      throw e;
    }
    return (await this.repo.findBatch(id))!;
  }
}
