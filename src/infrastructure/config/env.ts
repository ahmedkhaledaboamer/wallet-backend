/**
 * Environment → validated, typed configuration (zod). Fails fast with a readable
 * message on boot instead of misbehaving later.
 */
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { Amount } from "../../domain/amount";
import { isValidEvmAddress, toChecksumAddress } from "../../domain/address";
import type { EvmNetwork, Network } from "../../domain/network";
import type { AppSettings, NetworkInfo, OnchainNetwork } from "../../application/settings";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v === "yes");
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const decimal = (def: string) =>
  z
    .string()
    .default(def)
    .refine((v) => Amount.tryParse(v)?.isPositive() ?? false, "must be a positive decimal")
    .transform((v) => Amount.parse(v));
const optAddress = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || isValidEvmAddress(v), "must be a valid 0x address")
  .transform((v) => (v ? (toChecksumAddress(v) as `0x${string}`) : undefined));
const optUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  DATABASE_DRIVER: z.enum(["pg", "pglite"]).default("pg"),
  DATABASE_URL: z.string().default("postgres://payout:payout@localhost:5432/payout"),
  PGLITE_DIR: z.string().default("memory://"),
  QUEUE_DRIVER: z.enum(["bullmq", "memory"]).default("bullmq"),
  /** pglite only: seed demo data on boot when the DB is empty. */
  SEED_ON_BOOT: bool(true),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  DEMO_AUTH: bool(true),
  PAYOUTS_DRY_RUN: bool(true),
  /** Extra safety latch: real MEXC withdrawals are mainnet money; refuse unless explicitly allowed. */
  ALLOW_LIVE_MEXC: bool(false),

  MAX_BATCH_TOTAL: decimal("250000"),
  MAX_ROWS_MEXC: int(1000),
  MAX_ROWS_TRUST_WALLET: int(200),
  MAX_FILE_BYTES: int(2 * 1024 * 1024),
  MEXC_MIN_AMOUNT: decimal("1"),
  ASSET_MAX_DECIMALS: int(6),
  PAYOUT_MAX_ATTEMPTS: int(5),
  PAYOUT_RATE_LIMIT_PER_SEC: int(5),

  DRY_RUN_MIN_DELAY_MS: int(300),
  DRY_RUN_MAX_DELAY_MS: int(1500),
  /** Simulated Trust Wallet confirmation delay (dry-run without a contract). */
  DRY_RUN_CHAIN_CONFIRM_MS: int(6000),

  MEXC_BASE_URL: z.url().default("https://api.mexc.com"),
  MEXC_API_KEY: z.string().optional(),
  MEXC_API_SECRET: z.string().optional(),
  MEXC_TIMEOUT_MS: int(10_000),
  MEXC_RECV_WINDOW_MS: int(5_000),
  /** netWork codes — confirm with GET /api/v3/capital/config/getall for coin=USDT. */
  MEXC_NETWORK_TRC20: z.string().default("TRX"),
  MEXC_NETWORK_BEP20: z.string().default("BSC"),
  MEXC_NETWORK_ERC20: z.string().default("ETH"),

  TREASURY_ADDRESS: optAddress.default("0x8ba1f109551bD432803012645Ac136ddd64DBA72"),
  BEP20_CHAIN_ID: int(97),
  BEP20_RPC_URL: optUrl,
  BEP20_PAYOUT_CONTRACT: optAddress,
  BEP20_TOKEN_ADDRESS: optAddress,
  BEP20_TOKEN_DECIMALS: int(6),
  BEP20_CONFIRMATIONS: int(3),
  ERC20_CHAIN_ID: int(11155111),
  ERC20_RPC_URL: optUrl,
  ERC20_PAYOUT_CONTRACT: optAddress,
  ERC20_TOKEN_ADDRESS: optAddress,
  ERC20_TOKEN_DECIMALS: int(6),
  ERC20_CONFIRMATIONS: int(3),
  VERIFY_POLL_MS: int(5_000),
  VERIFY_TIMEOUT_MS: int(30 * 60_000),
});

export type Env = z.output<typeof schema>;

/** Placeholder addresses used only by the dry-run simulator when no contract is configured. */
const SIMULATED = {
  contract: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
} as const;

export interface OnchainRuntime extends OnchainNetwork {
  rpcUrl?: string;
  /** True when verification is simulated (dry-run AND no contract configured). */
  simulated: boolean;
}

export interface AppConfig {
  env: Env;
  settings: AppSettings;
  onchain: Partial<Record<EvmNetwork, OnchainRuntime>>;
  mexcNetworkCodes: Record<Network, string>;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const env = parsed.data;

  if (!env.PAYOUTS_DRY_RUN) {
    if (!env.MEXC_API_KEY || !env.MEXC_API_SECRET) throw new Error("PAYOUTS_DRY_RUN=false requires MEXC_API_KEY and MEXC_API_SECRET.");
    if (!env.ALLOW_LIVE_MEXC) {
      throw new Error("PAYOUTS_DRY_RUN=false sends REAL MEXC withdrawals (MEXC has no withdrawal testnet). Set ALLOW_LIVE_MEXC=true to confirm.");
    }
  }

  const onchain: AppConfig["onchain"] = {};
  for (const network of ["BEP20", "ERC20"] as const) {
    const contract = env[`${network}_PAYOUT_CONTRACT`];
    const token = env[`${network}_TOKEN_ADDRESS`];
    const rpcUrl = env[`${network}_RPC_URL`];
    const configured = Boolean(contract && token && rpcUrl);
    if (!configured && (contract || token || rpcUrl)) {
      throw new Error(`${network}: set all of ${network}_RPC_URL, ${network}_PAYOUT_CONTRACT and ${network}_TOKEN_ADDRESS (or none of them).`);
    }
    if (!configured && !env.PAYOUTS_DRY_RUN) continue; // live mode without a contract: Trust Wallet disabled on this network
    onchain[network] = {
      network,
      chainId: env[`${network}_CHAIN_ID`],
      contract: (contract ?? SIMULATED.contract) as `0x${string}`,
      token: (token ?? SIMULATED.token) as `0x${string}`,
      tokenDecimals: env[`${network}_TOKEN_DECIMALS`],
      treasury: env.TREASURY_ADDRESS!,
      confirmations: Math.max(1, env[`${network}_CONFIRMATIONS`]),
      rpcUrl,
      simulated: !configured,
    };
  }

  const networks: NetworkInfo[] = [
    { network: "TRC20", name: "TRON Nile Testnet", explorerUrl: "https://nile.tronscan.org/#" },
    { network: "BEP20", chainId: env.BEP20_CHAIN_ID, name: "BNB Smart Chain Testnet", explorerUrl: "https://testnet.bscscan.com" },
    { network: "ERC20", chainId: env.ERC20_CHAIN_ID, name: "Ethereum Sepolia", explorerUrl: "https://sepolia.etherscan.io" },
  ];

  const maxRowsByChannel = { mexc: env.MAX_ROWS_MEXC, trust_wallet: env.MAX_ROWS_TRUST_WALLET };
  const settings: AppSettings = {
    environment: "testnet",
    dryRun: env.PAYOUTS_DRY_RUN,
    limits: {
      maxRowsByChannel,
      maxBatchTotal: env.MAX_BATCH_TOTAL,
      minAmountByChannel: { mexc: env.MEXC_MIN_AMOUNT },
      maxDecimals: env.ASSET_MAX_DECIMALS,
    },
    maxFileBytes: env.MAX_FILE_BYTES,
    maxBatchTotal: env.MAX_BATCH_TOTAL,
    maxRowsByChannel,
    networks,
    onchain,
    verifyTimeoutMs: env.VERIFY_TIMEOUT_MS,
    verifyPollMs: env.VERIFY_POLL_MS,
    maxPayoutAttempts: Math.max(1, env.PAYOUT_MAX_ATTEMPTS),
  };

  return {
    env,
    settings,
    onchain,
    mexcNetworkCodes: { TRC20: env.MEXC_NETWORK_TRC20, BEP20: env.MEXC_NETWORK_BEP20, ERC20: env.MEXC_NETWORK_ERC20 },
  };
}

/** Startup warnings that must be visible in logs. */
export function logConfigWarnings(config: AppConfig, logger = new Logger("Config")) {
  if (config.env.PAYOUTS_DRY_RUN) logger.warn("PAYOUTS_DRY_RUN=true: MEXC withdrawals are SIMULATED (references ending -FAIL / -RECON simulate failures).");
  for (const n of Object.values(config.onchain)) {
    if (n?.simulated) {
      logger.warn(
        `${n.network}: no RPC/contract configured → Trust Wallet transactions are SIMULATED (any well-formed txHash is "confirmed"; marked simulated=true in the batch and audit log).`,
      );
    }
  }
  if (config.env.DEMO_AUTH) logger.warn("DEMO_AUTH=true: GET /demo/users exposes demo bearer tokens. Never enable in production.");
}
