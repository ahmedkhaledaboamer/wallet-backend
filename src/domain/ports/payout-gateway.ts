import type { Amount } from "../amount";
import type { Asset, Network } from "../network";

export interface PayoutRequest {
  /** Our item id (ULID). Sent as the provider's client order id → idempotent on the provider side. */
  itemId: string;
  reference: string;
  address: string;
  amount: Amount;
  asset: Asset;
  network: Network;
  memo?: string;
}

/**
 * Outcome of ONE send attempt, classified so the processor never guesses:
 * - accepted:  provider took the withdrawal (has an id) → item succeeded
 * - rejected:  provider definitively refused (4xx) → item failed, no retry
 * - retryable: request certainly did NOT reach the provider (DNS/refused) or was rate-limited (429) → retry with backoff
 * - unknown:   it MAY have been executed (timeout after send, 5xx, success without id) → requires_reconciliation, NEVER retried
 */
export type PayoutOutcome =
  | { status: "accepted"; providerReference: string; txHash?: string }
  | { status: "rejected"; reason: string; providerCode?: string }
  | { status: "retryable"; reason: string; retryAfterMs?: number }
  | { status: "unknown"; reason: string; providerReference?: string };

export interface PayoutGateway {
  readonly name: string;
  send(request: PayoutRequest): Promise<PayoutOutcome>;
}
export const PAYOUT_GATEWAY = Symbol("PayoutGateway");
