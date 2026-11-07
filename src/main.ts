import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createApiApp } from "./app.module";
import { RequeuePendingItems } from "./application/execute-batch";
import { loadConfig, logConfigWarnings } from "./infrastructure/config/env";
import { loadDotEnv } from "./infrastructure/config/dotenv";

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig();
  logConfigWarnings(config);
  const app = await createApiApp(config);
  await app.listen(config.env.PORT);
  if (config.env.QUEUE_DRIVER === "memory") {
    // No separate worker: the API process runs jobs; resume items left pending by a previous run.
    const n = await app.get(RequeuePendingItems).run();
    if (n) new Logger("Bootstrap").warn(`Re-enqueued ${n} pending item(s) of processing batches.`);
  }
  const logger = new Logger("Bootstrap");
  logger.log(`API on http://localhost:${config.env.PORT}/api · Swagger http://localhost:${config.env.PORT}/docs`);
  logger.log(`db=${config.env.DATABASE_DRIVER} queue=${config.env.QUEUE_DRIVER} dryRun=${config.env.PAYOUTS_DRY_RUN} demoAuth=${config.env.DEMO_AUTH}`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
