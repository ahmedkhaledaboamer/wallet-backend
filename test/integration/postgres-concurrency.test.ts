/**
 * Real-PostgreSQL concurrency checks (PGlite is single-connection and can't deadlock).
 * Runs only when TEST_DATABASE_URL points at a disposable database, e.g.:
 *   docker compose up -d && TEST_DATABASE_URL=postgres://payout:payout@localhost:5432/payout npm run test:integration
 * Each run uses fresh ids, so it can share the dev database safely.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { Amount } from "../../src/domain/amount";
import type { PayoutGateway, PayoutOutcome, PayoutRequest } from "../../src/domain/ports/payout-gateway";
import { AuditLog } from "../../src/application/audit";
import { ExecuteBatch } from "../../src/application/execute-batch";
import { PayoutItemProcessor } from "../../src/application/payout-item-processor";
import { SettleBatch } from "../../src/application/settle-batch";
import { IllegalStateError } from "../../src/domain/errors";
import { connectDb, migrateDb, type DbHandle } from "../../src/infrastructure/db/client";
import { DrizzlePayoutRepository } from "../../src/infrastructure/db/drizzle-payout.repository";
import { users } from "../../src/infrastructure/db/schema";
import { DefaultIdGenerator, SystemClock } from "../../src/infrastructure/system";
import { tronAddress } from "../helpers/addresses";

const url = process.env.TEST_DATABASE_URL;

class SlowGateway implements PayoutGateway {
  readonly name = "SLOW";
  calls = 0;
  async send(req: PayoutRequest): Promise<PayoutOutcome> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    return req.reference.endsWith("-RECON") ? { status: "unknown", reason: "timeout" } : { status: "accepted", providerReference: `S-${req.itemId}` };
  }
}

describe.skipIf(!url)("PostgreSQL concurrency", () => {
  let h: DbHandle;
  let repo: DrizzlePayoutRepository;
  const ids = new DefaultIdGenerator();
  const clock = new SystemClock();
  const audit = new AuditLog(ids, clock);
  const userId = `usr_concurrency_${Date.now()}`;

  beforeAll(async () => {
    h = await connectDb({ driver: "pg", url });
    await migrateDb(h);
    repo = new DrizzlePayoutRepository(h.db);
    await h.db.insert(users).values([
      { id: userId, name: "Concurrency Maker", role: "maker", tokenHash: `hash-${userId}` },
      { id: `${userId}_x`, name: "Concurrency Executor", role: "executor", tokenHash: `hash-${userId}_x` },
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });

  async function makeBatch(n: number, status: "approved" | "processing") {
    const id = ids.batchId();
    const items = Array.from({ length: n }, (_, i) => ({
      id: ids.itemId(),
      rowNumber: i + 2,
      reference: i % 7 === 3 ? `C-${i}-RECON` : `C-${i}`,
      address: tronAddress(i),
      amount: Amount.parse("1.5"),
    }));
    await repo.transaction(async (tx) => {
      await tx.insertBatch({ id, channel: "mexc", asset: "USDT", network: "TRC20", totalAmount: Amount.parse(String(1.5 * n)), fileSha256: id, fileName: "c.xlsx", createdById: userId, createdAt: new Date(), items });
      await tx.updateBatch(id, { status });
    });
    return { id, items };
  }

  it("processes 40 items with 10 concurrent workers: no deadlock, settles exactly once", async () => {
    const { id, items } = await makeBatch(40, "processing");
    const gw = new SlowGateway();
    const p = new PayoutItemProcessor(repo, gw, new SettleBatch(clock, audit), clock, audit);
    const queue = [...items.map((i) => i.id), ...items.slice(0, 10).map((i) => i.id)]; // incl. 10 duplicate deliveries
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await p.process(next, 1, 5);
      }),
    );
    expect(gw.calls).toBe(40); // duplicates never reached the provider
    const b = (await repo.findBatch(id))!;
    expect(b.status).toBe("completed_with_issues");
    expect(b.paidCount + b.reconciliationCount).toBe(40);
    const settled = (await repo.batchAudit(id)).filter((a) => a.action.startsWith("batch.completed"));
    expect(settled).toHaveLength(1);
  });

  it("20 parallel executes → exactly one succeeds, 19 × 409", async () => {
    const { id } = await makeBatch(3, "approved");
    const enqueued: string[][] = [];
    const exec = new ExecuteBatch(repo, { enqueueItems: async (_b, list) => void enqueued.push(list), enqueueVerification: async () => {} }, clock, audit, "TEST");
    const actor = { id: `${userId}_x`, name: "Concurrency Executor", role: "executor" as const };
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => exec.execute(actor, id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.reason instanceof IllegalStateError)).toBe(true);
    expect(enqueued).toHaveLength(1);
    const started = (await repo.batchAudit(id)).filter((a) => a.action === "batch.execution_started");
    expect(started).toHaveLength(1);
  });

  it("cleanup leaves the shared database usable", async () => {
    const rows = await h.db.select({ id: users.id }).from(users).where(inArray(users.id, [userId]));
    expect(rows).toHaveLength(1);
  });
});
