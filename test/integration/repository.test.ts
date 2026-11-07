import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Amount } from "../../src/domain/amount";
import { DuplicateFileError } from "../../src/application/import-withdrawal-sheet";
import { connectDb, migrateDb, type DbHandle } from "../../src/infrastructure/db/client";
import { DrizzlePayoutRepository } from "../../src/infrastructure/db/drizzle-payout.repository";
import { users } from "../../src/infrastructure/db/schema";
import { DefaultIdGenerator } from "../../src/infrastructure/system";

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres message is in the cause chain. */
async function causeChain(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    const out: string[] = [];
    for (let c: unknown = e; c instanceof Error; c = c.cause) out.push(c.message);
    return out.join(" <- ");
  }
}

let h: DbHandle;
let repo: DrizzlePayoutRepository;
const ids = new DefaultIdGenerator();

beforeAll(async () => {
  h = await connectDb({ driver: "pglite", pgliteDir: "memory://" });
  await migrateDb(h);
  repo = new DrizzlePayoutRepository(h.db);
  await h.db.insert(users).values({ id: "u1", name: "Sara", role: "maker", tokenHash: createHash("sha256").update("t").digest("hex") });
});
afterAll(() => h.close());

const newBatch = (sha: string) => ({
  id: ids.batchId(),
  channel: "mexc" as const,
  asset: "USDT" as const,
  network: "TRC20" as const,
  totalAmount: Amount.parse("0.3"),
  fileSha256: sha,
  fileName: "f.xlsx",
  createdById: "u1",
  createdAt: new Date(),
  items: [
    { id: ids.itemId(), rowNumber: 2, reference: "A", address: "T1", amount: Amount.parse("0.1") },
    { id: ids.itemId(), rowNumber: 3, reference: "B", address: "T2", amount: Amount.parse("0.200000000000000001") },
  ],
});

describe("Drizzle repository on PGlite", () => {
  it("round-trips numeric(36,18) exactly", async () => {
    const b = newBatch("sha-1");
    await repo.transaction((tx) => tx.insertBatch(b));
    const items = await repo.allItems(b.id);
    expect(items.map((i) => i.amount.toString())).toEqual(["0.1", "0.200000000000000001"]);
    expect((await repo.findBatch(b.id))?.totalAmount.toString()).toBe("0.3");
    expect((await repo.findUserByTokenHash(createHash("sha256").update("t").digest("hex")))?.name).toBe("Sara");
  });

  it("enforces one live batch per file hash; a rejected batch frees it", async () => {
    const a = newBatch("sha-dup");
    await repo.transaction((tx) => tx.insertBatch(a));
    await expect(repo.transaction((tx) => tx.insertBatch(newBatch("sha-dup")))).rejects.toBeInstanceOf(DuplicateFileError);
    await repo.updateBatch(a.id, { status: "rejected" });
    await expect(repo.transaction((tx) => tx.insertBatch(newBatch("sha-dup")))).resolves.toBeUndefined();
  });

  it("rolls back the whole transaction on error (all-or-nothing)", async () => {
    const b = newBatch("sha-rollback");
    await expect(
      repo.transaction(async (tx) => {
        await tx.insertBatch(b);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.findBatch(b.id)).toBeNull();
  });

  it("audit log is append-only (UPDATE/DELETE rejected by trigger)", async () => {
    const b = newBatch("sha-audit");
    await repo.transaction(async (tx) => {
      await tx.insertBatch(b);
      await tx.appendAudit({ id: ids.auditId(), batchId: b.id, action: "batch.created", actorId: "u1", context: { x: 1 }, createdAt: new Date() });
    });
    const [entry] = await repo.batchAudit(b.id);
    expect(entry?.actor?.name).toBe("Sara");
    expect(await causeChain(h.db.execute(sql`update audit_log set action = 'tampered'`))).toMatch(/append-only \(UPDATE/);
    expect(await causeChain(h.db.execute(sql`delete from audit_log`))).toMatch(/append-only \(DELETE/);
  });

  it("locks rows with FOR UPDATE inside a transaction", async () => {
    const b = newBatch("sha-lock");
    await repo.transaction((tx) => tx.insertBatch(b));
    const locked = await repo.transaction((tx) => tx.lockBatch(b.id));
    expect(locked?.status).toBe("draft");
    expect(await repo.transaction((tx) => tx.lockBatch("00000000-0000-4000-8000-000000000000"))).toBeNull();
  });
});
