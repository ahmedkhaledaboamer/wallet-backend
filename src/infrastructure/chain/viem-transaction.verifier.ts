import {
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from "viem";
import type { ExpectedOnchainPayout, TransactionVerifier, VerificationResult } from "../../domain/ports/transaction-verifier";
import { batchPayoutAbi } from "./batch-payout.abi";

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * Real verification over RPC. A transaction counts as paid only when ALL hold:
 *  - it has ≥ N confirmations and status = success
 *  - from == treasury, to == BatchPayout contract
 *  - the contract emitted BatchPaid with topics[1] == the exact batchRef we issued,
 *    payer == treasury, token == configured token, total and count == the batch.
 */
export class ViemTransactionVerifier implements TransactionVerifier {
  constructor(
    private readonly client: Pick<PublicClient, "getTransactionReceipt" | "getTransaction" | "getBlockNumber">,
    private readonly confirmations: number,
  ) {}

  static forRpc(rpcUrl: string, confirmations: number): ViemTransactionVerifier {
    return new ViemTransactionVerifier(createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) }), confirmations);
  }

  isSimulated(): boolean {
    return false;
  }

  async verify(x: ExpectedOnchainPayout): Promise<VerificationResult> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: x.txHash });
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
      try {
        await this.client.getTransaction({ hash: x.txHash });
        return { status: "pending", confirmations: 0, required: this.confirmations }; // in the mempool
      } catch (inner) {
        if (inner instanceof TransactionNotFoundError) return { status: "not_found" };
        throw inner;
      }
    }

    const latest = await this.client.getBlockNumber();
    const confirmations = Number(latest - receipt.blockNumber + 1n);
    if (confirmations < this.confirmations) return { status: "pending", confirmations, required: this.confirmations };

    if (receipt.status !== "success") return { status: "reverted", blockNumber: receipt.blockNumber };
    if (!same(receipt.from, x.treasury)) return { status: "mismatch", reason: `sent from ${receipt.from}, expected treasury ${x.treasury}` };
    if (!same(receipt.to, x.contract)) return { status: "mismatch", reason: `sent to ${receipt.to ?? "contract creation"}, expected ${x.contract}` };

    const contractLogs = receipt.logs.filter((l) => same(l.address, x.contract));
    const events = parseEventLogs({ abi: batchPayoutAbi, eventName: "BatchPaid", logs: contractLogs, strict: true });
    const match = events.find((ev) => same(ev.topics[1], x.batchRef));
    if (!match) return { status: "mismatch", reason: `no BatchPaid event for batchRef ${x.batchRef}` };
    const a = match.args;
    if (getAddress(a.payer) !== getAddress(x.treasury)) return { status: "mismatch", reason: `BatchPaid payer ${a.payer} is not the treasury` };
    if (getAddress(a.token) !== getAddress(x.token)) return { status: "mismatch", reason: `BatchPaid token ${a.token} is not ${x.token}` };
    if (a.total !== x.totalUnits) return { status: "mismatch", reason: `BatchPaid total ${a.total} != expected ${x.totalUnits}` };
    if (a.count !== BigInt(x.count)) return { status: "mismatch", reason: `BatchPaid count ${a.count} != expected ${x.count}` };

    return { status: "confirmed", blockNumber: receipt.blockNumber };
  }
}

/**
 * PAYOUTS_DRY_RUN=true AND no contract configured: accepts any well-formed hash and
 * "confirms" it after a short delay. Results are flagged simulated=true.
 */
export class SimulatedTransactionVerifier implements TransactionVerifier {
  private readonly firstSeen = new Map<string, number>();

  constructor(
    private readonly confirmAfterMs = 6_000,
    private readonly now: () => number = Date.now,
  ) {}

  isSimulated(): boolean {
    return true;
  }

  async verify(x: ExpectedOnchainPayout): Promise<VerificationResult> {
    const seen = this.firstSeen.get(x.txHash) ?? this.now();
    this.firstSeen.set(x.txHash, seen);
    if (this.now() - seen < this.confirmAfterMs) return { status: "pending", confirmations: 0, required: 1 };
    this.firstSeen.delete(x.txHash);
    return { status: "confirmed", blockNumber: 0n, simulated: true };
  }
}

/** Routes by chainId to a real or simulated verifier (decided once, at startup). */
export class ChainRoutingVerifier implements TransactionVerifier {
  constructor(private readonly byChain: Map<number, TransactionVerifier>) {}

  isSimulated(chainId: number): boolean {
    return this.byChain.get(chainId)?.isSimulated(chainId) ?? false;
  }

  verify(x: ExpectedOnchainPayout): Promise<VerificationResult> {
    const v = this.byChain.get(x.chainId);
    if (!v) return Promise.resolve({ status: "mismatch", reason: `no verifier configured for chain ${x.chainId}` });
    return v.verify(x);
  }
}
