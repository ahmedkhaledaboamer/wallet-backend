export const NETWORKS = ["TRC20", "BEP20", "ERC20"] as const;
export type Network = (typeof NETWORKS)[number];

export const EVM_NETWORKS = ["BEP20", "ERC20"] as const satisfies readonly Network[];
export type EvmNetwork = (typeof EVM_NETWORKS)[number];

export const CHANNELS = ["mexc", "trust_wallet"] as const;
export type Channel = (typeof CHANNELS)[number];

export const ROLES = ["maker", "checker", "executor"] as const;
export type Role = (typeof ROLES)[number];

export const SUPPORTED_ASSETS = ["USDT"] as const;
export type Asset = (typeof SUPPORTED_ASSETS)[number];

/** Which networks each channel can pay on. Trust Wallet is EVM-only. */
export const CHANNEL_NETWORKS: Record<Channel, readonly Network[]> = {
  mexc: NETWORKS,
  trust_wallet: EVM_NETWORKS,
};

export const isNetwork = (v: unknown): v is Network => typeof v === "string" && (NETWORKS as readonly string[]).includes(v);
export const isEvmNetwork = (v: unknown): v is EvmNetwork => typeof v === "string" && (EVM_NETWORKS as readonly string[]).includes(v);
export const isChannel = (v: unknown): v is Channel => typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
export const isAsset = (v: unknown): v is Asset => typeof v === "string" && (SUPPORTED_ASSETS as readonly string[]).includes(v);
