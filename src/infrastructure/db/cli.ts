/**
 *   npm run db:migrate   apply migrations (drizzle/)
 *   npm run db:seed      demo users + demo batches (idempotent)
 */
import { loadDotEnv } from "../config/dotenv";
import { loadConfig } from "../config/env";
import { connectDb, migrateDb } from "./client";
import { seedDemoData } from "./seed";

async function main() {
  loadDotEnv();
  const { env } = loadConfig();
  const cmd = process.argv[2];
  const handle = await connectDb({ driver: env.DATABASE_DRIVER, url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
  try {
    if (cmd === "migrate" || cmd === "setup") {
      await migrateDb(handle);
      console.log(`migrations applied (${env.DATABASE_DRIVER})`);
    }
    if (cmd === "seed" || cmd === "setup") {
      if (handle.driver === "pglite") await migrateDb(handle);
      const r = await seedDemoData(handle.db);
      console.log(r.skipped ? "seed skipped: users already exist" : `seeded ${r.users} users and ${r.batches} batches`);
    }
    if (!["migrate", "seed", "setup"].includes(cmd ?? "")) {
      console.error("usage: cli.ts <migrate|seed|setup>");
      process.exitCode = 2;
    }
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
