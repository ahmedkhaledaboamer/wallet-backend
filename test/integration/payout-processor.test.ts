import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Amount } from "../../src/domain/amount";
import type { PayoutGateway, PayoutOutcome, PayoutRequest } from "../../src/domain/ports/payout-gateway";
import { AuditLog } from "../../src/application/audit";
import { PayoutItemProcessor } from "../../src/application/payout-item-processor";
import { SettleBatch } from "../../src/application/settle-batch";
import { connectDb, migrateDb, type DbHandle } from "../../src/infrastructure/db/client";
import { DrizzlePayoutRepository } from "../../src/infrastructure/db/drizzle-payout.repository";
import { users } from "../../src/infrastructure/db/schema";
import { DefaultIdGenerator, SystemClock } from "../../src/infrastructure/system";
import { InMemoryPayoutQueue } from "../../src/infrastructure/queue/in-memory.queue";
import { createJobHandlers } from "../../src/infrastructure/queue/job-handlers";
import { tronAddress } from "../helpers/addresses";

/** Gateway that replays a script of outcomes and records every call. */
class ScriptedGateway implements PayoutGateway {
  readonly name = "SCRIPTED";
  calls: PayoutRequest[] = [];
  constructor(private script: (PayoutOutcome | Error)[]) {}
  async send(req: PayoutRequest): Promise<PayoutOutcome> {
    this.calls.push(req);
    const next = this.script.shift() ?? { status: "accepted", providerReference: `P-${this.calls.length}` };
    if (next instanceof Error) throw next;
    return next;
  }
}

let h: DbHandle;
let repo: DrizzlePayoutRepository;
const ids = new DefaultIdGenerator();
const clock = new SystemClock();
const audit = new AuditLog(ids, clock);
const settle = new SettleBatch(clock, audit);

beforeAll(async () => {
  h = await connectDb({ driver: "pglite" });
  await migrateDb(h);
  repo = new DrizzlePayoutRepository(h.db);
  await h.db.insert(users).values({ id: "u1", name: "Sara", role: "maker", tokenHash: "x" });
});
afterAll(() => h.close());

let batchId: string;
let itemIds: string[];
beforeEach(async () => {
  batchId = ids.batchId();
  itemIds = [ids.itemId(), ids.itemId()];
  await repo.transaction(async (tx) => {
    await tx.insertBatch({
      id: batchId,
      channel: "mexc",
      asset: "USDT",
      network: "TRC20",
      totalAmount: Amount.parse("20"),
      fileSha256: batchId,
      fileName: "f.xlsx",
      createdById: "u1",
      createdAt: new Date(),
      items: itemIds.map((id, i) => ({ id, rowNumber: i + 2, reference: `R-${i}`, address: tronAddress(i), amount: Amount.parse("10") })),
    });
    await tx.updateBatch(batchId, { status: "processing", executedAt: new Date() });
  });
});

const processor = (gw: PayoutGateway) => new PayoutItemProcessor(repo, gw, settle, clock, audit);
const item = async (id: string) => (await repo.findItem(id))!;
const actions = async () => (await repo.batchAudit(batchId)).map((a) => a.action);

describe("PayoutItemProcessor", () => {
  it("retries only 'retryable' outcomes, then succeeds", async () => {
    const gw = new ScriptedGateway([{ status: "retryable", reason: "ECONNREFUSED" }, { status: "retryable", reason: "429" }]);
    const p = processor(gw);
    expect((await p.process(itemIds[0]!, 1, 5)).kind).toBe("retry");
    expect((await item(itemIds[0]!)).sending).toBe(false); // safe to retry
    expect((await p.process(itemIds[0]!, 2, 5)).kind).toBe("retry");
    expect(await p.process(itemIds[0]!, 3, 5)).toEqual({ kind: "done", status: "succeeded" });
    const it0 = await item(itemIds[0]!);
    expect(it0).toMatchObject({ status: "succeeded", attempts: 3, sending: false, providerReference: "P-3" });
    expect((await actions()).filter((a) => a === "item.retry_scheduled")).toHaveLength(2);
  });

  it("fails an item when retries are exhausted (the request never executed)", async () => {
    const gw = new ScriptedGateway([{ status: "retryable", reason: "ENOTFOUND" }]);
    expect(await processor(gw).process(itemIds[0]!, 5, 5)).toEqual({ kind: "done", status: "failed" });
    expect((await item(itemIds[0]!)).failureReason).toMatch(/unreachable after 5 attempts/);
  });

  it("an unknown outcome → requires_reconciliation and is NEVER sent again", async () => {
    const gw = new ScriptedGateway([{ status: "unknown", reason: "timeout after send" }]);
    const p = processor(gw);
    expect(await p.process(itemIds[0]!, 1, 5)).toEqual({ kind: "done", status: "requires_reconciliation" });
    // Duplicate delivery of the same job (e.g. BullMQ stalled-job recovery):
    expect((await p.process(itemIds[0]!, 2, 5)).kind).toBe("skipped");
    expect(gw.calls).toHaveLength(1);
  });

  it("a crash mid-send (sending=true) → requires_reconciliation without calling the provider", async () => {
    await repo.updateItem(itemIds[0]!, { status: "processing", sending: true, attempts: 1 });
    const gw = new ScriptedGateway([]);
    expect((await processor(gw).process(itemIds[0]!, 2, 5)).kind).toBe("skipped");
    expect(gw.calls).toHaveLength(0);
    expect((await item(itemIds[0]!)).status).toBe("requires_reconciliation");
  });

  it("a gateway exception is treated as unknown (never retried)", async () => {
    const gw = new ScriptedGateway([new Error("bug after request left")]);
    expect(await processor(gw).process(itemIds[0]!, 1, 5)).toEqual({ kind: "done", status: "requires_reconciliation" });
  });

  it("4xx rejection → failed", async () => {
    const gw = new ScriptedGateway([{ status: "rejected", reason: "address not whitelisted", providerCode: "30001" }]);
    expect(await processor(gw).process(itemIds[0]!, 1, 5)).toEqual({ kind: "done", status: "failed" });
  });

  it("settles the batch only when no item is in flight, under the batch lock", async () => {
    const gw = new ScriptedGateway([{ status: "accepted", providerReference: "A" }, { status: "unknown", reason: "5xx" }]);
    const p = processor(gw);
    await p.process(itemIds[0]!, 1, 5);
    let b = (await repo.findBatch(batchId))!;
    expect(b).toMatchObject({ status: "processing", paidCount: 1 });
    await p.process(itemIds[1]!, 1, 5);
    b = (await repo.findBatch(batchId))!;
    expect(b).toMatchObject({ status: "completed_with_issues", paidCount: 1, reconciliationCount: 1 });
    expect((await actions()).at(-1)).toBe("batch.completed_with_issues");
  });

  it("skips items of a batch that isn't processing", async () => {
    await repo.updateBatch(batchId, { status: "approved" });
    const gw = new ScriptedGateway([]);
    expect((await processor(gw).process(itemIds[0]!, 1, 5)).kind).toBe("skipped");
    expect(gw.calls).toHaveLength(0);
  });
});

describe("InMemoryPayoutQueue", () => {
  it("dedupes jobIds and retries with backoff through the processor", async () => {
    const gw = new ScriptedGateway([{ status: "retryable", reason: "429", retryAfterMs: 5 }]);
    const q = new InMemoryPayoutQueue({ maxAttempts: 3, backoffMs: 5, concurrency: 2 });
    q.attach(createJobHandlers(processor(gw), undefined as never));
    await q.enqueueItems(batchId, itemIds);
    await q.enqueueItems(batchId, itemIds); // double enqueue → no-op
    await q.drain();
    expect(q.errors).toEqual([]);
    expect(gw.calls).toHaveLength(3); // 2 items + 1 retry of whichever item got the 429
    expect(new Set(gw.calls.map((c) => c.itemId))).toEqual(new Set(itemIds));
    expect((await repo.findBatch(batchId))!.status).toBe("completed");
  });
});
