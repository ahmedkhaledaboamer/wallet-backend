import { IllegalStateError } from "./errors";

export const BATCH_STATUSES = ["draft", "approved", "rejected", "processing", "completed", "completed_with_issues", "failed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

const TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  draft: ["approved", "rejected"],
  approved: ["processing"],
  processing: ["completed", "completed_with_issues", "failed"],
  rejected: [],
  completed: [],
  completed_with_issues: [],
  failed: [],
};

export const FINAL_BATCH_STATUSES: readonly BatchStatus[] = ["rejected", "completed", "completed_with_issues", "failed"];

export const isBatchStatus = (v: unknown): v is BatchStatus =>
  typeof v === "string" && (BATCH_STATUSES as readonly string[]).includes(v);

export function canTransitionBatch(from: BatchStatus, to: BatchStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws IllegalStateError (HTTP 409) for anything not in the transition table. */
export function assertBatchTransition(batchId: string, from: BatchStatus, to: BatchStatus): void {
  if (!canTransitionBatch(from, to)) {
    throw new IllegalStateError(`Batch ${batchId} is ${from} and cannot become ${to}`);
  }
}

/** Final batch status from item outcome counts. */
export function settledBatchStatus(counts: { itemCount: number; succeeded: number; failed: number; reconciliation: number }): BatchStatus {
  const { itemCount, succeeded, failed, reconciliation } = counts;
  if (succeeded + failed + reconciliation !== itemCount) {
    throw new IllegalStateError("Batch still has items in flight");
  }
  if (succeeded === itemCount) return "completed";
  if (failed === itemCount) return "failed";
  return "completed_with_issues";
}
