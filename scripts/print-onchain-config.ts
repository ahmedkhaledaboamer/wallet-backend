/** Prints which networks are verified for real vs. simulated (no secrets). Run: npx tsx scripts/print-onchain-config.ts */
import { loadDotEnv } from "../src/infrastructure/config/dotenv";
import { loadConfig } from "../src/infrastructure/config/env";

loadDotEnv();
const c = loadConfig();
console.log(`PAYOUTS_DRY_RUN=${c.env.PAYOUTS_DRY_RUN} (MEXC ${c.env.PAYOUTS_DRY_RUN ? "simulated" : "LIVE"})`);
for (const n of Object.values(c.onchain)) {
  if (!n) continue;
  console.log(`${n.network}: chain=${n.chainId} ${n.simulated ? "SIMULATED" : "REAL verification"} contract=${n.contract} token=${n.token} decimals=${n.tokenDecimals} confirmations=${n.confirmations} treasury=${n.treasury}`);
}
