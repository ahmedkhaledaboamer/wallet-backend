import type { ParsedSheet } from "../withdrawal-rules";

export class UnreadableSheetError extends Error {
  constructor(cause?: unknown) {
    super("Not a readable .xlsx workbook", { cause });
    this.name = "UnreadableSheetError";
  }
}

export interface SheetReader {
  /** Throws UnreadableSheetError for anything that isn't a readable .xlsx. */
  read(bytes: Uint8Array): Promise<ParsedSheet>;
}
export const SHEET_READER = Symbol("SheetReader");
