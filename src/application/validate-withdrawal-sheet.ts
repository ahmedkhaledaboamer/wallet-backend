import { createHash } from "node:crypto";
import type { Channel } from "../domain/network";
import type { PayoutRepository } from "../domain/ports/payout-repository";
import { UnreadableSheetError, type SheetReader } from "../domain/ports/sheet-reader";
import { fileError, validateWithdrawalSheet, type SheetValidation } from "../domain/withdrawal-rules";
import { Amount } from "../domain/amount";
import type { AppSettings } from "./settings";

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileValidation extends SheetValidation {
  sha256: string;
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Size → readability → sheet rules → duplicate-file check. Never throws for user input problems. */
export class ValidateWithdrawalSheet {
  constructor(
    private readonly reader: SheetReader,
    private readonly repo: PayoutRepository,
    private readonly settings: AppSettings,
  ) {}

  async execute(file: UploadedFile, channel: Channel): Promise<FileValidation> {
    const sha256 = sha256Hex(file.bytes);
    const invalid = (errors: SheetValidation["errors"]): FileValidation => ({
      valid: false,
      rowCount: 0,
      totalAmount: Amount.ZERO,
      errors,
      withdrawals: [],
      sha256,
    });

    if (file.bytes.byteLength > this.settings.maxFileBytes) {
      return invalid([fileError("file.too_large", { size: file.bytes.byteLength, max: this.settings.maxFileBytes })]);
    }

    let result: SheetValidation;
    try {
      result = validateWithdrawalSheet(await this.reader.read(file.bytes), channel, this.settings.limits);
    } catch (e) {
      if (e instanceof UnreadableSheetError) return invalid([fileError("file.unreadable")]);
      throw e;
    }

    const existing = await this.repo.findActiveBatchByFileHash(sha256);
    if (existing) {
      const duplicate = fileError("file.duplicate", { batchId: existing.id });
      const errors = [...result.errors];
      const fileRow = errors.find((e) => e.row === 0);
      if (fileRow) {
        fileRow.issues.unshift(duplicate.issues[0]!);
        fileRow.messages.unshift(duplicate.messages[0]!);
      } else errors.unshift(duplicate);
      return { ...result, valid: false, errors, withdrawals: [], sha256 };
    }
    return { ...result, sha256 };
  }
}
