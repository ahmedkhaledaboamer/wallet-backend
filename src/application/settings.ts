/** Configuration the application layer needs, decoupled from how infrastructure loads it. */
import type { Amount } from "../domain/amount";
import type { Channel, EvmNetwork, Network } from "../domain/network";
import type { WithdrawalLimits } from "../domain/withdrawal-rules";

export interface NetworkInfo {
  network: Network;
  chainId?: number;
  name: string;
  explorerUrl: string;
}

export interface OnchainNetwork {
  network: EvmNetwork;
  chainId: number;
  contract: `0x${string}`;
  token: `0x${string}`;
  tokenDecimals: number;
  treasury: `0x${string}`;
  confirmations: number;
}

export interface AppSettings {
  environment: "testnet";
  dryRun: boolean;
  limits: WithdrawalLimits;
  maxFileBytes: number;
  maxBatchTotal: Amount;
  maxRowsByChannel: Record<Channel, number>;
  networks: NetworkInfo[];
  onchain: Partial<Record<EvmNetwork, OnchainNetwork>>;
  /** How long to keep polling for an unseen / unconfirmed tx before flagging reconciliation. */
  verifyTimeoutMs: number;
  verifyPollMs: number;
  maxPayoutAttempts: number;
}

export const APP_SETTINGS = Symbol("AppSettings");
