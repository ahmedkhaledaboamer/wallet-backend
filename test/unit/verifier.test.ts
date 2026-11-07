import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hash } from "viem";
import { uuidToBatchRef } from "../../src/domain/batch-ref";
import type { ExpectedOnchainPayout } from "../../src/domain/ports/transaction-verifier";
import { batchPayoutAbi } from "../../src/infrastructure/chain/batch-payout.abi";
import { ChainRoutingVerifier, SimulatedTransactionVerifier, ViemTransactionVerifier } from "../../src/infrastructure/chain/viem-transaction.verifier";

const TREASURY = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const REF = uuidToBatchRef("3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b");
const HASH = `0x${"ab".repeat(32)}` as Hash;

const expected: ExpectedOnchainPayout = { txHash: HASH, chainId: 97, treasury: TREASURY, contract: CONTRACT, token: TOKEN, batchRef: REF, totalUnits: 6_000_000n, count: 3 };

function batchPaidLog(over: Partial<{ ref: `0x${string}`; token: `0x${string}`; payer: `0x${string}`; total: bigint; count: bigint; address: string }> = {}) {
  const topics = encodeEventTopics({
    abi: batchPayoutAbi,
    eventName: "BatchPaid",
    args: { batchRef: over.ref ?? REF, token: over.token ?? TOKEN, payer: over.payer ?? TREASURY },
  });
  return {
    address: over.address ?? CONTRACT,
    topics,
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [over.total ?? 6_000_000n, over.count ?? 3n]),
    blockNumber: 100n,
    blockHash: HASH,
    logIndex: 0,
    transactionHash: HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function fakeClient(receipt: Record<string, unknown> | "missing" | "mempool", latest = 102n) {
  return {
    async getTransactionReceipt() {
      if (receipt === "missing" || receipt === "mempool") throw new TransactionReceiptNotFoundError({ hash: HASH });
      return { status: "success", from: TREASURY.toLowerCase(), to: CONTRACT.toLowerCase(), blockNumber: 100n, logs: [batchPaidLog()], ...receipt };
    },
    async getTransaction() {
      if (receipt === "missing") throw new TransactionNotFoundError({ hash: HASH });
      return {};
    },
    async getBlockNumber() {
      return latest;
    },
  } as never;
}

const verify = (receipt: Parameters<typeof fakeClient>[0], latest?: bigint, confirmations = 3) =>
  new ViemTransactionVerifier(fakeClient(receipt, latest), confirmations).verify(expected);

describe("ViemTransactionVerifier", () => {
  it("confirms a matching BatchPaid after N confirmations", async () => {
    expect(await verify({})).toEqual({ status: "confirmed", blockNumber: 100n });
  });

  it("is pending until enough confirmations", async () => {
    expect(await verify({}, 101n)).toEqual({ status: "pending", confirmations: 2, required: 3 });
  });

  it("pending while in the mempool, not_found when unknown", async () => {
    expect((await verify("mempool")).status).toBe("pending");
    expect((await verify("missing")).status).toBe("not_found");
  });

  it("reverted", async () => {
    expect((await verify({ status: "reverted" })).status).toBe("reverted");
  });

  it.each([
    ["from is not the treasury", { from: "0x0000000000000000000000000000000000000001" }],
    ["to is not the contract", { to: "0x0000000000000000000000000000000000000002" }],
    ["batchRef differs (topics[1])", { logs: [batchPaidLog({ ref: uuidToBatchRef("00000000-0000-4000-8000-000000000000") })] }],
    ["payer differs", { logs: [batchPaidLog({ payer: "0x0000000000000000000000000000000000000003" })] }],
    ["token differs", { logs: [batchPaidLog({ token: "0x0000000000000000000000000000000000000004" })] }],
    ["total differs", { logs: [batchPaidLog({ total: 5_999_999n })] }],
    ["count differs", { logs: [batchPaidLog({ count: 2n })] }],
    ["event from another contract", { logs: [batchPaidLog({ address: "0x0000000000000000000000000000000000000005" })] }],
    ["no event at all", { logs: [] }],
  ])("mismatch when %s", async (_, receipt) => {
    expect((await verify(receipt)).status).toBe("mismatch");
  });
});

describe("simulated + routing verifiers", () => {
  it("simulator confirms after its delay and flags simulated", async () => {
    let t = 0;
    const sim = new SimulatedTransactionVerifier(1000, () => t);
    expect((await sim.verify(expected)).status).toBe("pending");
    t = 1500;
    expect(await sim.verify(expected)).toEqual({ status: "confirmed", blockNumber: 0n, simulated: true });
  });

  it("routes by chainId and reports which chains are simulated", async () => {
    const router = new ChainRoutingVerifier(new Map([[97, new SimulatedTransactionVerifier(0)]]));
    expect(router.isSimulated(97)).toBe(true);
    expect(router.isSimulated(11155111)).toBe(false);
    expect((await router.verify({ ...expected, chainId: 1 })).status).toBe("mismatch");
  });
});
