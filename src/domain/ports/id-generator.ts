export interface IdGenerator {
  /** Batch ids are UUIDs (they double as the on-chain bytes32 batchRef). */
  batchId(): string;
  /** Item ids are ULIDs (used as MEXC withdrawOrderId and BullMQ jobId). */
  itemId(): string;
  /** Audit entry ids. */
  auditId(): string;
}
export const ID_GENERATOR = Symbol("IdGenerator");
