import type { PayoutGateway, PayoutOutcome, PayoutRequest } from "../domain/ports/payout-gateway";

/**
 * PAYOUTS_DRY_RUN=true: nothing leaves the server. Same conventions as the frontend mock:
 * a reference ending in -FAIL is rejected, -RECON has an unknown outcome; everything else succeeds.
 * A small random delay per item makes progress visible in the UI.
 */
export class DryRunPayoutGateway implements PayoutGateway {
  readonly name = "DRY_RUN";

  constructor(
    private readonly delay: { minMs: number; maxMs: number } = { minMs: 300, maxMs: 1500 },
    private readonly random: () => number = Math.random,
  ) {}

  async send(req: PayoutRequest): Promise<PayoutOutcome> {
    const { minMs, maxMs } = this.delay;
    const ms = minMs + Math.floor(this.random() * Math.max(0, maxMs - minMs));
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));

    const ref = req.reference.trim().toUpperCase();
    if (ref.endsWith("-FAIL")) return { status: "rejected", reason: "[dry-run] Withdrawal address is not whitelisted on MEXC." };
    if (ref.endsWith("-RECON")) return { status: "unknown", reason: "[dry-run] Provider timed out after the request was sent; outcome unknown." };
    return { status: "accepted", providerReference: `DRYRUN-${req.itemId}` };
  }
}
