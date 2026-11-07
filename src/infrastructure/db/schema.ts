import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** numeric(36,18): exact money, read back as a string and parsed into Amount. */
const money = (name: string) => numeric(name, { precision: 36, scale: 18 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role", { enum: ["maker", "checker", "executor"] }).notNull(),
  /** sha256(bearer token) — tokens themselves are never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey(),
    channel: text("channel", { enum: ["mexc", "trust_wallet"] }).notNull(),
    status: text("status", {
      enum: ["draft", "approved", "rejected", "processing", "completed", "completed_with_issues", "failed"],
    }).notNull(),
    asset: text("asset", { enum: ["USDT"] }).notNull(),
    network: text("network", { enum: ["TRC20", "BEP20", "ERC20"] }).notNull(),
    totalAmount: money("total_amount").notNull(),
    itemCount: integer("item_count").notNull(),
    paidCount: integer("paid_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    reconciliationCount: integer("reconciliation_count").notNull().default(0),
    fileSha256: text("file_sha256").notNull(),
    fileName: text("file_name").notNull(),
    createdById: text("created_by_id").notNull().references(() => users.id),
    approvedById: text("approved_by_id").references(() => users.id),
    executedById: text("executed_by_id").references(() => users.id),
    rejectionReason: text("rejection_reason"),
    txHash: text("tx_hash"),
    simulated: boolean("simulated").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    approvedAt: ts("approved_at"),
    executedAt: ts("executed_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    // Duplicate-file protection at the DB level: one LIVE batch per file; rejected batches free the hash.
    uniqueIndex("batches_file_sha256_active_uq").on(t.fileSha256).where(sql`${t.status} <> 'rejected'`),
    // A transaction hash can settle only one batch.
    uniqueIndex("batches_tx_hash_uq").on(t.txHash).where(sql`${t.txHash} is not null`),
    index("batches_status_idx").on(t.status, t.createdAt),
    index("batches_channel_idx").on(t.channel, t.createdAt),
  ],
);

export const batchItems = pgTable(
  "batch_items",
  {
    id: text("id").primaryKey(), // ULID
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    rowNumber: integer("row_number").notNull(),
    reference: text("reference").notNull(),
    address: text("address").notNull(),
    amount: money("amount").notNull(),
    memo: text("memo"),
    status: text("status", { enum: ["pending", "processing", "succeeded", "failed", "requires_reconciliation"] }).notNull(),
    providerReference: text("provider_reference"),
    failureReason: text("failure_reason"),
    txHash: text("tx_hash"),
    attempts: integer("attempts").notNull().default(0),
    /** Set true before the provider call is made; a crash leaves it true → reconciliation, never a re-send. */
    sending: boolean("sending").notNull().default(false),
    processedAt: ts("processed_at"),
  },
  (t) => [
    index("batch_items_batch_status_idx").on(t.batchId, t.status),
    index("batch_items_batch_row_idx").on(t.batchId, t.rowNumber),
    uniqueIndex("batch_items_batch_reference_uq").on(t.batchId, sql`upper(${t.reference})`),
  ],
);

/** Append-only (UPDATE/DELETE are blocked by a trigger, see migrations). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // ULID → sortable
    batchId: uuid("batch_id").references(() => batches.id),
    action: text("action").notNull(),
    actorId: text("actor_id").references(() => users.id),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("audit_log_batch_idx").on(t.batchId, t.createdAt), index("audit_log_action_idx").on(t.action, t.createdAt)],
);

export const schema = { users, batches, batchItems, auditLog };
