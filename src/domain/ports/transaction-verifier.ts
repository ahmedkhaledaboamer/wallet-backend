export interface ExpectedOnchainPayout {
  txHash: `0x${string}`;
  chainId: number;
  treasury: `0x${string}`;
  contract: `0x${string}`;
  token: `0x${string}`;
  /** Exact bytes32 batchRef handed to the client in /onchain-payload. */
  batchRef: `0x${string}`;
  /** Expected total in token base units and recipient count (checked against the BatchPaid event). */
  totalUnits: bigint;
  count: number;
}

export type VerificationResult =
  | { status: "pending"; confirmations: number; required: number }
  | { status: "not_found" }
  | { status: "confirmed"; blockNumber: bigint; simulated?: boolean }
  | { status: "reverted"; blockNumber: bigint }
  | { status: "mismatch"; reason: string };

export interface TransactionVerifier {
  /** True when this chain is verified by the dry-run simulator (no contract/RPC configured). */
  isSimulated(chainId: number): boolean;
  verify(expected: ExpectedOnchainPayout): Promise<VerificationResult>;
}
export const TRANSACTION_VERIFIER = Symbol("TransactionVerifier");
