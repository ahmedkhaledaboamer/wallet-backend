import "reflect-metadata";
import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RequeuePendingItems } from "./application/execute-batch";
import { CoreModule, JOB_HANDLERS } from "./core.module";
import { loadConfig, logConfigWarnings, type AppConfig } from "./infrastructure/config/env";
import { loadDotEnv } from "./infrastructure/config/dotenv";
import { BullMqWorkers } from "./infrastructure/queue/bullmq.queue";
import type { JobHandlers } from "./infrastructure/queue/job-handlers";

@Module({})
class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: WorkerModule, imports: [CoreModule.forRoot(config)] };
  }
}

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig();
  const logger = new Logger("Worker");
  if (config.env.QUEUE_DRIVER === "memory") {
    logger.warn("QUEUE_DRIVER=memory: jobs run inside the API process; this worker has nothing to do.");
    return;
  }
  logConfigWarnings(config, logger);
  const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: ["log", "warn", "error"] });
  ctx.enableShutdownHooks();

  const workers = new BullMqWorkers(
    {
      redisUrl: config.env.REDIS_URL,
      maxAttempts: config.settings.maxPayoutAttempts,
      backoffMs: 2000,
      ratePerSecond: config.env.PAYOUT_RATE_LIMIT_PER_SEC,
      concurrency: 4,
    },
    ctx.get<JobHandlers>(JOB_HANDLERS),
  );
  workers.start();

  // Safety net: items committed as pending but never enqueued (e.g. API crashed after commit).
  const requeued = await ctx.get(RequeuePendingItems).run();
  if (requeued) logger.warn(`Re-enqueued ${requeued} pending item(s) of processing batches.`);

  const stop = async (signal: string) => {
    logger.log(`${signal}: draining workers…`);
    await workers.close();
    await ctx.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
