/**
 * Composition root shared by the API (main.ts) and the worker (worker.ts).
 * Every port is bound to an explicit DI token via a factory — no reflection-based
 * constructor injection — so the wiring is visible in one place.
 */
import { Global, Inject, Logger, Module, type OnApplicationShutdown, type Provider } from "@nestjs/common";
import { AuditLog } from "./application/audit";
import { ConfirmOnchainBatch } from "./application/confirm-onchain-batch";
import { ExecuteBatch, RequeuePendingItems } from "./application/execute-batch";
import { ImportWithdrawalSheet } from "./application/import-withdrawal-sheet";
import { PayoutItemProcessor } from "./application/payout-item-processor";
import { PrepareOnchainBatch } from "./application/prepare-onchain-batch";
import { PayoutQueries } from "./application/queries";
import { ReviewBatch } from "./application/review-batch";
import { APP_SETTINGS, type AppSettings } from "./application/settings";
import { SettleBatch } from "./application/settle-batch";
import { ValidateWithdrawalSheet } from "./application/validate-withdrawal-sheet";
import { CLOCK, type Clock } from "./domain/ports/clock";
import { ID_GENERATOR, type IdGenerator } from "./domain/ports/id-generator";
import { PAYOUT_GATEWAY, type PayoutGateway } from "./domain/ports/payout-gateway";
import { PAYOUT_QUEUE, type PayoutQueue } from "./domain/ports/payout-queue";
import { PAYOUT_REPOSITORY, type PayoutRepository } from "./domain/ports/payout-repository";
import { SHEET_READER, type SheetReader } from "./domain/ports/sheet-reader";
import { TRANSACTION_VERIFIER, type TransactionVerifier } from "./domain/ports/transaction-verifier";
import { ChainRoutingVerifier, SimulatedTransactionVerifier, ViemTransactionVerifier } from "./infrastructure/chain/viem-transaction.verifier";
import type { AppConfig } from "./infrastructure/config/env";
import { connectDb, migrateDb, type DbHandle } from "./infrastructure/db/client";
import { DrizzlePayoutRepository } from "./infrastructure/db/drizzle-payout.repository";
import { DryRunPayoutGateway } from "./infrastructure/dry-run-payout.gateway";
import { MexcClient } from "./infrastructure/mexc/mexc.client";
import { MexcPayoutGateway } from "./infrastructure/mexc/mexc-payout.gateway";
import { BullMqPayoutQueue } from "./infrastructure/queue/bullmq.queue";
import { InMemoryPayoutQueue } from "./infrastructure/queue/in-memory.queue";
import { createJobHandlers, type JobHandlers } from "./infrastructure/queue/job-handlers";
import { DefaultIdGenerator, SystemClock } from "./infrastructure/system";
import { ExcelSheetReader } from "./infrastructure/xlsx/sheet-reader";

export const APP_CONFIG = Symbol("AppConfig");
export const DB_HANDLE = Symbol("DbHandle");
export const JOB_HANDLERS = Symbol("JobHandlers");

/** THE gateway strategy decision: dry-run simulator or real MEXC. Nowhere else. */
export function createPayoutGateway(config: AppConfig): PayoutGateway {
  const { env } = config;
  if (env.PAYOUTS_DRY_RUN) return new DryRunPayoutGateway({ minMs: env.DRY_RUN_MIN_DELAY_MS, maxMs: env.DRY_RUN_MAX_DELAY_MS });
  return new MexcPayoutGateway(
    new MexcClient({
      baseUrl: env.MEXC_BASE_URL,
      apiKey: env.MEXC_API_KEY!,
      apiSecret: env.MEXC_API_SECRET!,
      timeoutMs: env.MEXC_TIMEOUT_MS,
      recvWindowMs: env.MEXC_RECV_WINDOW_MS,
    }),
    config.mexcNetworkCodes,
  );
}

/** Real RPC verification wherever a contract is configured; the simulator only for dry-run networks without one. */
export function createVerifier(config: AppConfig): TransactionVerifier {
  const byChain = new Map<number, TransactionVerifier>();
  for (const n of Object.values(config.onchain)) {
    if (!n) continue;
    byChain.set(n.chainId, n.simulated ? new SimulatedTransactionVerifier() : ViemTransactionVerifier.forRpc(n.rpcUrl!, n.confirmations));
  }
  return new ChainRoutingVerifier(byChain);
}

export function createQueue(config: AppConfig): PayoutQueue {
  const { env } = config;
  if (env.QUEUE_DRIVER === "memory") {
    return new InMemoryPayoutQueue({ maxAttempts: config.settings.maxPayoutAttempts, backoffMs: 1000, concurrency: 2 });
  }
  return new BullMqPayoutQueue({
    redisUrl: env.REDIS_URL,
    maxAttempts: config.settings.maxPayoutAttempts,
    backoffMs: 2000,
    ratePerSecond: env.PAYOUT_RATE_LIMIT_PER_SEC,
    concurrency: 4,
  });
}

const useCase = <T>(provide: abstract new (...args: never[]) => T, inject: (symbol | Function)[], factory: (...deps: never[]) => T): Provider => ({
  provide,
  inject,
  useFactory: factory,
});

@Global()
@Module({})
export class CoreModule implements OnApplicationShutdown {
  private readonly logger = new Logger("Core");

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(PAYOUT_QUEUE) private readonly queue: PayoutQueue,
  ) {}

  static forRoot(config: AppConfig) {
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_SETTINGS, useValue: config.settings },
      {
        provide: DB_HANDLE,
        useFactory: async () => {
          const handle = await connectDb({ driver: config.env.DATABASE_DRIVER, url: config.env.DATABASE_URL, pgliteDir: config.env.PGLITE_DIR });
          if (handle.driver === "pglite") await migrateDb(handle); // embedded DB: always migrate on boot
          return handle;
        },
      },
      { provide: PAYOUT_REPOSITORY, inject: [DB_HANDLE], useFactory: (h: DbHandle) => new DrizzlePayoutRepository(h.db) },
      { provide: CLOCK, useClass: SystemClock },
      { provide: ID_GENERATOR, useClass: DefaultIdGenerator },
      { provide: SHEET_READER, useClass: ExcelSheetReader },
      { provide: PAYOUT_GATEWAY, useFactory: () => createPayoutGateway(config) },
      { provide: TRANSACTION_VERIFIER, useFactory: () => createVerifier(config) },
      { provide: PAYOUT_QUEUE, useFactory: () => createQueue(config) },
      useCase(AuditLog, [ID_GENERATOR, CLOCK], (ids: IdGenerator, clock: Clock) => new AuditLog(ids, clock)),
      useCase(SettleBatch, [CLOCK, AuditLog], (clock: Clock, audit: AuditLog) => new SettleBatch(clock, audit)),
      useCase(
        ValidateWithdrawalSheet,
        [SHEET_READER, PAYOUT_REPOSITORY, APP_SETTINGS],
        (r: SheetReader, repo: PayoutRepository, s: AppSettings) => new ValidateWithdrawalSheet(r, repo, s),
      ),
      useCase(
        ImportWithdrawalSheet,
        [ValidateWithdrawalSheet, PAYOUT_REPOSITORY, ID_GENERATOR, CLOCK, AuditLog],
        (v: ValidateWithdrawalSheet, repo: PayoutRepository, ids: IdGenerator, clock: Clock, audit: AuditLog) =>
          new ImportWithdrawalSheet(v, repo, ids, clock, audit),
      ),
      useCase(
        ReviewBatch,
        [PAYOUT_REPOSITORY, CLOCK, AuditLog, APP_SETTINGS],
        (repo: PayoutRepository, clock: Clock, audit: AuditLog, s: AppSettings) => new ReviewBatch(repo, clock, audit, s),
      ),
      useCase(
        ExecuteBatch,
        [PAYOUT_REPOSITORY, PAYOUT_QUEUE, CLOCK, AuditLog, PAYOUT_GATEWAY],
        (repo: PayoutRepository, q: PayoutQueue, clock: Clock, audit: AuditLog, gw: PayoutGateway) => new ExecuteBatch(repo, q, clock, audit, gw.name),
      ),
      useCase(RequeuePendingItems, [PAYOUT_REPOSITORY, PAYOUT_QUEUE], (repo: PayoutRepository, q: PayoutQueue) => new RequeuePendingItems(repo, q)),
      useCase(
        PayoutItemProcessor,
        [PAYOUT_REPOSITORY, PAYOUT_GATEWAY, SettleBatch, CLOCK, AuditLog],
        (repo: PayoutRepository, gw: PayoutGateway, settle: SettleBatch, clock: Clock, audit: AuditLog) => new PayoutItemProcessor(repo, gw, settle, clock, audit),
      ),
      useCase(PrepareOnchainBatch, [PAYOUT_REPOSITORY, APP_SETTINGS], (repo: PayoutRepository, s: AppSettings) => new PrepareOnchainBatch(repo, s)),
      useCase(
        ConfirmOnchainBatch,
        [PAYOUT_REPOSITORY, PAYOUT_QUEUE, TRANSACTION_VERIFIER, SettleBatch, CLOCK, AuditLog, APP_SETTINGS],
        (repo: PayoutRepository, q: PayoutQueue, v: TransactionVerifier, settle: SettleBatch, clock: Clock, audit: AuditLog, s: AppSettings) =>
          new ConfirmOnchainBatch(repo, q, v, settle, clock, audit, s),
      ),
      useCase(PayoutQueries, [PAYOUT_REPOSITORY], (repo: PayoutRepository) => new PayoutQueries(repo)),
      {
        provide: JOB_HANDLERS,
        inject: [PayoutItemProcessor, ConfirmOnchainBatch, PAYOUT_QUEUE],
        useFactory: (p: PayoutItemProcessor, c: ConfirmOnchainBatch, q: PayoutQueue): JobHandlers => {
          const handlers = createJobHandlers(p, c);
          if (q instanceof InMemoryPayoutQueue) q.attach(handlers); // QUEUE_DRIVER=memory: process in this process
          return handlers;
        },
      },
    ];
    return { module: CoreModule, providers, exports: providers.map((p) => (typeof p === "function" ? p : p.provide)) };
  }

  async onApplicationShutdown() {
    if (this.queue instanceof InMemoryPayoutQueue) this.queue.close();
    if (this.queue instanceof BullMqPayoutQueue) await this.queue.close();
    await this.db.close();
    this.logger.log("Closed database and queue connections");
  }
}
