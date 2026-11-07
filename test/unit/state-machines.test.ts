import { describe, expect, it } from "vitest";
import { BATCH_STATUSES, assertBatchTransition, canTransitionBatch, settledBatchStatus } from "../../src/domain/batch-status";
import { IllegalStateError } from "../../src/domain/errors";
import { ITEM_STATUSES, assertItemTransition, canTransitionItem } from "../../src/domain/item-status";

describe("batch state machine", () => {
  const legal: [string, string][] = [
    ["draft", "approved"],
    ["draft", "rejected"],
    ["approved", "processing"],
    ["processing", "completed"],
    ["processing", "completed_with_issues"],
    ["processing", "failed"],
  ];

  it("allows exactly the documented transitions", () => {
    for (const from of BATCH_STATUSES) {
      for (const to of BATCH_STATUSES) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(canTransitionBatch(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("throws IllegalStateError (409) on illegal transitions", () => {
    expect(() => assertBatchTransition("b1", "approved", "processing")).not.toThrow();
    expect(() => assertBatchTransition("b1", "processing", "processing")).toThrow(IllegalStateError);
    expect(() => assertBatchTransition("b1", "draft", "processing")).toThrow(/draft and cannot become processing/);
    expect(() => assertBatchTransition("b1", "completed", "approved")).toThrow(IllegalStateError);
  });

  it("settles from item outcomes", () => {
    expect(settledBatchStatus({ itemCount: 3, succeeded: 3, failed: 0, reconciliation: 0 })).toBe("completed");
    expect(settledBatchStatus({ itemCount: 3, succeeded: 0, failed: 3, reconciliation: 0 })).toBe("failed");
    expect(settledBatchStatus({ itemCount: 3, succeeded: 2, failed: 1, reconciliation: 0 })).toBe("completed_with_issues");
    expect(settledBatchStatus({ itemCount: 3, succeeded: 0, failed: 0, reconciliation: 3 })).toBe("completed_with_issues");
    expect(() => settledBatchStatus({ itemCount: 3, succeeded: 2, failed: 0, reconciliation: 0 })).toThrow(/in flight/);
  });
});

describe("item state machine", () => {
  it("pending -> processing -> final, nothing else", () => {
    for (const from of ITEM_STATUSES) {
      for (const to of ITEM_STATUSES) {
        const expected =
          (from === "pending" && to === "processing") ||
          (from === "processing" && ["succeeded", "failed", "requires_reconciliation"].includes(to));
        expect(canTransitionItem(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("final statuses never change (an unknown outcome is never retried)", () => {
    expect(() => assertItemTransition("i1", "requires_reconciliation", "processing")).toThrow(IllegalStateError);
    expect(() => assertItemTransition("i1", "succeeded", "failed")).toThrow(IllegalStateError);
  });
});
