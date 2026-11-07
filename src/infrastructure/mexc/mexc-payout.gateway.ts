import type { Network } from "../../domain/network";
import type { PayoutGateway, PayoutOutcome, PayoutRequest } from "../../domain/ports/payout-gateway";
import type { MexcClient } from "./mexc.client";

export const MEXC_WITHDRAW_PATH = "/api/v3/capital/withdraw";

/**
 * MEXC custodial withdrawals. withdrawOrderId = our item ULID, so MEXC itself
 * deduplicates a withdrawal that we might (in theory) send twice.
 *
 * Classification (never guess):
 *   not delivered (DNS/refused) or HTTP 429  → retryable
 *   other 4xx                               → rejected (failed)
 *   5xx, timeout after send, 2xx without id → unknown (requires_reconciliation, never retried)
 */
export class MexcPayoutGateway implements PayoutGateway {
  readonly name = "MEXC";

  constructor(
    private readonly client: MexcClient,
    private readonly networkCodes: Record<Network, string>,
  ) {}

  async send(req: PayoutRequest): Promise<PayoutOutcome> {
    const res = await this.client.signedRequest("POST", MEXC_WITHDRAW_PATH, {
      coin: req.asset,
      withdrawOrderId: req.itemId,
      netWork: this.networkCodes[req.network],
      address: req.address,
      amount: req.amount.toString(),
      memo: req.memo,
      remark: req.reference,
    });

    if (res.kind === "not_sent") return { status: "retryable", reason: res.reason };
    if (res.kind === "maybe_sent") return { status: "unknown", reason: res.reason };

    const body = (res.body ?? {}) as { id?: unknown; code?: unknown; msg?: unknown };
    const providerMsg = typeof body.msg === "string" ? body.msg : undefined;
    const providerCode = body.code !== undefined ? String(body.code) : undefined;

    if (res.status === 429) return { status: "retryable", reason: "MEXC rate limit (429)", retryAfterMs: res.retryAfterMs };
    if (res.status >= 400 && res.status < 500) {
      return { status: "rejected", reason: `MEXC rejected the withdrawal (${res.status}${providerCode ? ` / ${providerCode}` : ""}): ${providerMsg ?? "no message"}`, providerCode };
    }
    if (res.status >= 500) return { status: "unknown", reason: `MEXC server error ${res.status}; withdrawal may or may not exist.` };

    if (typeof body.id === "string" && body.id) return { status: "accepted", providerReference: body.id };
    if (typeof body.id === "number") return { status: "accepted", providerReference: String(body.id) };
    return { status: "unknown", reason: `MEXC returned ${res.status} without a withdrawal id.` };
  }
}
