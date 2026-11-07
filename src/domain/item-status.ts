import { IllegalStateError } from "./errors";

export const ITEM_STATUSES = ["pending", "processing", "succeeded", "failed", "requires_reconciliation"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  pending: ["processing"],
  processing: ["succeeded", "failed", "requires_reconciliation"],
  succeeded: [],
  failed: [],
  requires_reconciliation: [],
};

export const FINAL_ITEM_STATUSES: readonly ItemStatus[] = ["succeeded", "failed", "requires_reconciliation"];

export const isItemStatus = (v: unknown): v is ItemStatus =>
  typeof v === "string" && (ITEM_STATUSES as readonly string[]).includes(v);

export const isFinalItemStatus = (s: ItemStatus) => FINAL_ITEM_STATUSES.includes(s);

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertItemTransition(itemId: string, from: ItemStatus, to: ItemStatus): void {
  if (!canTransitionItem(from, to)) {
    throw new IllegalStateError(`Item ${itemId} is ${from} and cannot become ${to}`);
  }
}
