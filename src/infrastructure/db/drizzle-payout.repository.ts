import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { Amount } from "../../domain/amount";
import type { ItemStatus } from "../../domain/item-status";
import { ITEM_STATUSES } from "../../domain/item-status";
import { CHANNELS } from "../../domain/network";
import type {
  AuditFilter,
  AuditRecord,
  BatchFilter,
  BatchRecord,
  DashboardTotals,
  ItemFilter,
  ItemRecord,
  NewBatch,
  Paged,
  PayoutRepository,
  PayoutRepositoryTx,
  UserRecord,
} from "../../domain/ports/payout-repository";
import { DuplicateFileError } from "../../application/import-withdrawal-sheet";
import type { Db } from "./client";
import { auditLog, batchItems, batches, users } from "./schema";

type Executor = Pick<Db, "select" | "insert" | "update" | "execute">;

const creator = alias(users, "creator");
const approver = alias(users, "approver");
const executor = alias(users, "executor");

const userCols = <T extends { id: AnyPgColumn; name: AnyPgColumn; role: AnyPgColumn }>(u: T) => ({ id: u.id, name: u.name, role: u.role });
const batchSelect = {
  b: batches,
  creator: userCols(creator),
  approver: userCols(approver),
  executor: userCols(executor),
};

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const user = (u: { id: string | null; name: string | null; role: UserRecord["role"] | null } | null): UserRecord | undefined =>
  u && u.id ? { id: u.id, name: u.name!, role: u.role! } : undefined;

function toBatch(row: { b: typeof batches.$inferSelect; creator: unknown; approver: unknown; executor: unknown }): BatchRecord {
  const b = row.b;
  return {
    id: b.id,
    channel: b.channel,
    status: b.status,
    asset: b.asset,
    network: b.network,
    totalAmount: Amount.parse(String(b.totalAmount)),
    itemCount: b.itemCount,
    paidCount: b.paidCount,
    failedCount: b.failedCount,
    reconciliationCount: b.reconciliationCount,
    fileSha256: b.fileSha256,
    fileName: b.fileName,
    createdBy: user(row.creator as never)!,
    approvedBy: user(row.approver as never),
    executedBy: user(row.executor as never),
    rejectionReason: opt(b.rejectionReason),
    txHash: opt(b.txHash),
    simulated: b.simulated,
    createdAt: b.createdAt,
    approvedAt: opt(b.approvedAt),
    executedAt: opt(b.executedAt),
    completedAt: opt(b.completedAt),
  };
}

function toItem(i: typeof batchItems.$inferSelect): ItemRecord {
  return {
    id: i.id,
    batchId: i.batchId,
    rowNumber: i.rowNumber,
    reference: i.reference,
    address: i.address,
    amount: Amount.parse(String(i.amount)),
    memo: opt(i.memo),
    status: i.status,
    providerReference: opt(i.providerReference),
    failureReason: opt(i.failureReason),
    txHash: opt(i.txHash),
    attempts: i.attempts,
    sending: i.sending,
    processedAt: opt(i.processedAt),
  };
}

/** Patch objects use `undefined` = "clear this column" only when the key is present. */
function nullify<T extends object>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? null : v instanceof Amount ? v.toString() : v;
  return out;
}

function pgErrorCode(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const c = cur as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (c.code) return { code: c.code, constraint: c.constraint ?? c.constraint_name };
    cur = c.cause;
  }
  return {};
}

class DrizzleTx implements PayoutRepositoryTx {
  constructor(protected readonly db: Executor) {}

  protected batchQuery() {
    return this.db
      .select(batchSelect)
      .from(batches)
      .innerJoin(creator, eq(creator.id, batches.createdById))
      .leftJoin(approver, eq(approver.id, batches.approvedById))
      .leftJoin(executor, eq(executor.id, batches.executedById));
  }

  async getBatch(id: string): Promise<BatchRecord | null> {
    const [row] = await this.batchQuery().where(eq(batches.id, id)).limit(1);
    return row ? toBatch(row) : null;
  }

  async lockBatch(id: string): Promise<BatchRecord | null> {
    // FOR NO KEY UPDATE, not FOR UPDATE: audit_log/batch_items inserts take FOR KEY SHARE on the batch
    // (foreign-key check). FOR UPDATE conflicts with that and deadlocks two workers settling the same batch;
    // NO KEY UPDATE doesn't (we never change the primary key). Locked first, then read (no outer-join locking).
    const locked = await this.db.select({ id: batches.id }).from(batches).where(eq(batches.id, id)).for("no key update");
    if (!locked.length) return null;
    return this.getBatch(id);
  }

  async updateBatch(id: string, patch: Parameters<PayoutRepositoryTx["updateBatch"]>[1]): Promise<void> {
    if (!Object.keys(patch).length) return;
    await this.db.update(batches).set(nullify(patch)).where(eq(batches.id, id));
  }

  async lockItem(id: string): Promise<ItemRecord | null> {
    const [row] = await this.db.select().from(batchItems).where(eq(batchItems.id, id)).for("no key update");
    return row ? toItem(row) : null;
  }

  async updateItem(id: string, patch: Partial<Omit<ItemRecord, "id" | "batchId">>): Promise<void> {
    if (!Object.keys(patch).length) return;
    await this.db.update(batchItems).set(nullify(patch)).where(eq(batchItems.id, id));
  }

  async updateItemsByBatch(batchId: string, from: ItemStatus, patch: Partial<Omit<ItemRecord, "id" | "batchId">>): Promise<number> {
    const rows = await this.db
      .update(batchItems)
      .set(nullify(patch))
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.status, from)))
      .returning({ id: batchItems.id });
    return rows.length;
  }

  async countItemsByStatus(batchId: string): Promise<Record<ItemStatus, number>> {
    const rows = await this.db
      .select({ status: batchItems.status, n: count() })
      .from(batchItems)
      .where(eq(batchItems.batchId, batchId))
      .groupBy(batchItems.status);
    const out = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  async insertBatch(b: NewBatch): Promise<void> {
    try {
      await this.db.insert(batches).values({
        id: b.id,
        channel: b.channel,
        status: "draft",
        asset: b.asset,
        network: b.network,
        totalAmount: b.totalAmount.toString(),
        itemCount: b.items.length,
        fileSha256: b.fileSha256,
        fileName: b.fileName,
        createdById: b.createdById,
        createdAt: b.createdAt,
      });
    } catch (e) {
      const { code, constraint } = pgErrorCode(e);
      if (code === "23505" && (!constraint || constraint.includes("file_sha256"))) throw new DuplicateFileError();
      throw e;
    }
    for (let i = 0; i < b.items.length; i += 500) {
      await this.db.insert(batchItems).values(
        b.items.slice(i, i + 500).map((it) => ({
          id: it.id,
          batchId: b.id,
          rowNumber: it.rowNumber,
          reference: it.reference,
          address: it.address,
          amount: it.amount.toString(),
          memo: it.memo ?? null,
          status: "pending" as const,
        })),
      );
    }
  }

  async appendAudit(entry: Parameters<PayoutRepositoryTx["appendAudit"]>[0]): Promise<void> {
    const actorId = "actorId" in entry ? entry.actorId : "actor" in entry ? entry.actor?.id : undefined;
    await this.db.insert(auditLog).values({
      id: entry.id,
      batchId: entry.batchId,
      action: entry.action,
      actorId: actorId ?? null,
      context: entry.context,
      createdAt: entry.createdAt,
    });
  }
}

export class DrizzlePayoutRepository extends DrizzleTx implements PayoutRepository {
  constructor(private readonly root: Db) {
    super(root);
  }

  transaction<T>(fn: (tx: PayoutRepositoryTx) => Promise<T>): Promise<T> {
    return this.root.transaction((tx) => fn(new DrizzleTx(tx as unknown as Executor)));
  }

  async findUserByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    const [u] = await this.root.select(userCols(users)).from(users).where(eq(users.tokenHash, tokenHash)).limit(1);
    return u ?? null;
  }

  findBatch(id: string): Promise<BatchRecord | null> {
    return this.getBatch(id);
  }

  async findActiveBatchByFileHash(sha256: string): Promise<BatchRecord | null> {
    const [row] = await this.batchQuery()
      .where(and(eq(batches.fileSha256, sha256), sql`${batches.status} <> 'rejected'`))
      .limit(1);
    return row ? toBatch(row) : null;
  }

  async listBatches(f: BatchFilter): Promise<Paged<BatchRecord>> {
    const where = and(f.status ? eq(batches.status, f.status) : undefined, f.channel ? eq(batches.channel, f.channel) : undefined);
    const [rows, [total]] = await Promise.all([
      this.batchQuery()
        .where(where)
        .orderBy(desc(batches.createdAt), desc(batches.id))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      this.root.select({ n: count() }).from(batches).where(where),
    ]);
    return { data: rows.map(toBatch), total: Number(total?.n ?? 0) };
  }

  async listItems(batchId: string, f: ItemFilter): Promise<Paged<ItemRecord>> {
    const conds: (SQL | undefined)[] = [eq(batchItems.batchId, batchId), f.status ? eq(batchItems.status, f.status) : undefined];
    const q = f.search?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(or(ilike(batchItems.reference, like), ilike(batchItems.address, like), ilike(batchItems.providerReference, like)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.root
        .select()
        .from(batchItems)
        .where(where)
        .orderBy(asc(batchItems.rowNumber))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      this.root.select({ n: count() }).from(batchItems).where(where),
    ]);
    return { data: rows.map(toItem), total: Number(total?.n ?? 0) };
  }

  async allItems(batchId: string): Promise<ItemRecord[]> {
    const rows = await this.root.select().from(batchItems).where(eq(batchItems.batchId, batchId)).orderBy(asc(batchItems.rowNumber));
    return rows.map(toItem);
  }

  async findItem(id: string): Promise<ItemRecord | null> {
    const [row] = await this.root.select().from(batchItems).where(eq(batchItems.id, id)).limit(1);
    return row ? toItem(row) : null;
  }

  private auditQuery() {
    return this.root
      .select({ a: auditLog, actor: userCols(users) })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId));
  }

  private toAudit(r: { a: typeof auditLog.$inferSelect; actor: unknown }): AuditRecord {
    return {
      id: r.a.id,
      batchId: r.a.batchId ?? "",
      action: r.a.action,
      actor: user(r.actor as never),
      context: r.a.context ?? {},
      createdAt: r.a.createdAt,
    };
  }

  async batchAudit(batchId: string): Promise<AuditRecord[]> {
    const rows = await this.auditQuery().where(eq(auditLog.batchId, batchId)).orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    return rows.map((r) => this.toAudit(r));
  }

  async listAudit(f: AuditFilter): Promise<Paged<AuditRecord>> {
    const where = and(f.batchId ? eq(auditLog.batchId, f.batchId) : undefined, f.action ? eq(auditLog.action, f.action) : undefined);
    const [rows, [total]] = await Promise.all([
      this.auditQuery()
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      this.root.select({ n: count() }).from(auditLog).where(where),
    ]);
    return { data: rows.map((r) => this.toAudit(r)), total: Number(total?.n ?? 0) };
  }

  async dashboard(): Promise<DashboardTotals> {
    const [paidRows, statusRows, reconRows, channelRows] = await Promise.all([
      this.root
        .select({ channel: batches.channel, total: sql<string>`coalesce(sum(${batchItems.amount}), 0)::text` })
        .from(batchItems)
        .innerJoin(batches, eq(batches.id, batchItems.batchId))
        .where(eq(batchItems.status, "succeeded"))
        .groupBy(batches.channel),
      this.root
        .select({ status: batches.status, n: count() })
        .from(batches)
        .where(inArray(batches.status, ["draft", "processing"]))
        .groupBy(batches.status),
      this.root.select({ n: count() }).from(batchItems).where(eq(batchItems.status, "requires_reconciliation")),
      this.root.select({ channel: batches.channel, n: count() }).from(batches).groupBy(batches.channel),
    ]);
    const paid = new Map(paidRows.map((r) => [r.channel, Amount.parse(r.total)]));
    const byStatus = new Map(statusRows.map((r) => [r.status, Number(r.n)]));
    const batchCount = new Map(channelRows.map((r) => [r.channel, Number(r.n)]));
    return {
      totalPaid: Amount.sum(paid.values()),
      pendingApprovalCount: byStatus.get("draft") ?? 0,
      processingCount: byStatus.get("processing") ?? 0,
      needsReconciliationCount: Number(reconRows[0]?.n ?? 0),
      byChannel: CHANNELS.map((channel) => ({
        channel,
        totalPaid: paid.get(channel) ?? Amount.ZERO,
        batchCount: batchCount.get(channel) ?? 0,
      })),
    };
  }
}
