/**
 * Demo data: the 4 demo users + realistic batches in every status, so the
 * dashboard isn't empty. Deterministic (fixed PRNG) and idempotent (skips if users exist).
 */
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { monotonicFactory } from "ulid";
import { Amount } from "../../domain/amount";
import { toChecksumAddress } from "../../domain/address";
import type { BatchStatus } from "../../domain/batch-status";
import type { ItemStatus } from "../../domain/item-status";
import type { Channel, Network } from "../../domain/network";
import type { Db } from "./client";
import { DEMO_USERS } from "./demo-users";
import { auditLog, batchItems, batches, users } from "./schema";

const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

function randomBytes(rnd: () => number, n: number) {
  return Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
}
function tronAddress(rnd: () => number): string {
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(randomBytes(rnd, 20), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(sha256(sha256(payload)).subarray(0, 4), 21);
  return base58(full);
}
function evmAddress(rnd: () => number): string {
  return toChecksumAddress(`0x${Array.from(randomBytes(rnd, 20), (b) => b.toString(16).padStart(2, "0")).join("")}`);
}
const hex32 = (rnd: () => number) => `0x${Array.from(randomBytes(rnd, 32), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const uuid = (rnd: () => number) => {
  const h = Array.from(randomBytes(rnd, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

interface Spec {
  channel: Channel;
  network: Network;
  items: number;
  status: BatchStatus;
  daysAgo: number;
  failed?: number;
  recon?: number;
  /** processing only: how many items are already done. */
  done?: number;
  maker?: "usr_sara_haddad" | "usr_youssef_amin";
}

const SPECS: Spec[] = [
  { channel: "mexc", network: "TRC20", items: 24, status: "completed", daysAgo: 20 },
  { channel: "trust_wallet", network: "BEP20", items: 12, status: "completed", daysAgo: 16 },
  { channel: "mexc", network: "TRC20", items: 18, status: "completed_with_issues", daysAgo: 12, failed: 1, recon: 1, maker: "usr_youssef_amin" },
  { channel: "mexc", network: "BEP20", items: 9, status: "rejected", daysAgo: 9 },
  { channel: "mexc", network: "ERC20", items: 4, status: "failed", daysAgo: 7, failed: 4 },
  { channel: "trust_wallet", network: "ERC20", items: 7, status: "completed", daysAgo: 5, maker: "usr_youssef_amin" },
  { channel: "mexc", network: "TRC20", items: 10, status: "processing", daysAgo: 0, done: 6 },
  { channel: "mexc", network: "TRC20", items: 15, status: "approved", daysAgo: 1 },
  { channel: "trust_wallet", network: "BEP20", items: 6, status: "approved", daysAgo: 1 },
  { channel: "mexc", network: "TRC20", items: 21, status: "draft", daysAgo: 0 },
  { channel: "trust_wallet", network: "ERC20", items: 5, status: "draft", daysAgo: 0, maker: "usr_youssef_amin" },
];

export async function seedDemoData(db: Db, now = new Date()): Promise<{ users: number; batches: number; skipped: boolean }> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return { users: 0, batches: 0, skipped: true };

  await db.insert(users).values(DEMO_USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, tokenHash: hashToken(u.token) })));

  const rnd = prng(20261107);
  const ulid = monotonicFactory(() => rnd());
  const day = 86_400_000;
  const at = (ms: number) => new Date(ms);

  for (const [n, spec] of SPECS.entries()) {
    const id = uuid(rnd);
    const maker = spec.maker ?? "usr_sara_haddad";
    const created = now.getTime() - spec.daysAgo * day - Math.floor(rnd() * 5 + 1) * 3_600_000;
    const approved = created + Math.floor(rnd() * 120 + 20) * 60_000;
    const executed = approved + Math.floor(rnd() * 180 + 30) * 60_000;
    const completed = executed + Math.floor(rnd() * 10 + 1) * 60_000;
    const txHash = spec.channel === "trust_wallet" && ["completed", "completed_with_issues", "failed", "processing"].includes(spec.status) ? hex32(rnd) : undefined;

    const items = Array.from({ length: spec.items }, (_, i) => {
      const cents = 2_500 + Math.floor(rnd() * 477_500); // 25.00 – 4,800.00
      return {
        id: ulid(created + i),
        rowNumber: i + 2,
        reference: `WD-${String(1001 + n).padStart(4, "0")}-${String(i + 1).padStart(3, "0")}`,
        address: spec.network === "TRC20" ? tronAddress(rnd) : evmAddress(rnd),
        amount: Amount.parse(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`),
      };
    });
    const total = Amount.sum(items.map((i) => i.amount));

    // Item outcomes for the seeded status.
    const statusOf = (i: number): ItemStatus => {
      switch (spec.status) {
        case "completed":
          return "succeeded";
        case "failed":
          return "failed";
        case "completed_with_issues":
          return i === spec.items - 1 && spec.failed ? "failed" : i === spec.items - 3 && spec.recon ? "requires_reconciliation" : "succeeded";
        case "processing":
          return i < (spec.done ?? 0) ? "succeeded" : "pending";
        default:
          return "pending";
      }
    };
    const rows = items.map((it, i) => {
      const status = statusOf(i);
      const final = status === "succeeded" || status === "failed" || status === "requires_reconciliation";
      return {
        id: it.id,
        batchId: id,
        rowNumber: it.rowNumber,
        reference: it.reference,
        address: it.address,
        amount: it.amount.toString(),
        status,
        providerReference: status === "succeeded" || status === "requires_reconciliation" ? (txHash ?? `DRYRUN-${it.id}`) : null,
        failureReason:
          status === "failed"
            ? "[dry-run] Withdrawal address is not whitelisted on MEXC."
            : status === "requires_reconciliation"
              ? "[dry-run] Provider timed out after the request was sent; outcome unknown."
              : null,
        txHash: txHash ?? null,
        attempts: final ? 1 : 0,
        processedAt: final ? at(spec.status === "processing" ? executed + i * 1000 : completed) : null,
      };
    });
    const count = (s: ItemStatus) => rows.filter((r) => r.status === s).length;
    const reviewed = spec.status !== "draft";
    const isApproved = reviewed && spec.status !== "rejected";
    const isExecuted = ["processing", "completed", "completed_with_issues", "failed"].includes(spec.status);
    const isFinal = ["completed", "completed_with_issues", "failed"].includes(spec.status);

    await db.insert(batches).values({
      id,
      channel: spec.channel,
      status: spec.status,
      asset: "USDT",
      network: spec.network,
      totalAmount: total.toString(),
      itemCount: items.length,
      paidCount: count("succeeded"),
      failedCount: count("failed"),
      reconciliationCount: count("requires_reconciliation"),
      fileSha256: createHash("sha256").update(`seed-${n}`).digest("hex"),
      fileName: `withdrawals-${1001 + n}.xlsx`,
      createdById: maker,
      approvedById: isApproved ? "usr_omar_khalil" : null,
      executedById: isExecuted ? "usr_lina_mansour" : null,
      rejectionReason: spec.status === "rejected" ? "Two references don't match the payroll export — please fix and re-upload." : null,
      txHash: txHash ?? null,
      simulated: Boolean(txHash),
      createdAt: at(created),
      approvedAt: isApproved ? at(approved) : null,
      executedAt: isExecuted ? at(executed) : null,
      completedAt: isFinal ? at(completed) : null,
    });
    for (let i = 0; i < rows.length; i += 500) await db.insert(batchItems).values(rows.slice(i, i + 500));

    const audit: (typeof auditLog.$inferInsert)[] = [
      { id: ulid(created), batchId: id, action: "batch.created", actorId: maker, createdAt: at(created), context: { fileName: `withdrawals-${1001 + n}.xlsx`, rowCount: items.length, totalAmount: total.toString(), channel: spec.channel, network: spec.network, asset: "USDT", seeded: true } },
    ];
    if (spec.status === "rejected") audit.push({ id: ulid(approved), batchId: id, action: "batch.rejected", actorId: "usr_omar_khalil", createdAt: at(approved), context: { reason: "Two references don't match the payroll export — please fix and re-upload." } });
    if (isApproved) audit.push({ id: ulid(approved), batchId: id, action: "batch.approved", actorId: "usr_omar_khalil", createdAt: at(approved), context: { totalAmount: total.toString(), itemCount: items.length } });
    if (isExecuted) {
      audit.push(
        spec.channel === "mexc"
          ? { id: ulid(executed), batchId: id, action: "batch.execution_started", actorId: "usr_lina_mansour", createdAt: at(executed), context: { provider: "DRY_RUN", itemCount: items.length, totalAmount: total.toString() } }
          : { id: ulid(executed), batchId: id, action: "batch.transaction_submitted", actorId: "usr_lina_mansour", createdAt: at(executed), context: { txHash, simulated: true } },
      );
    }
    for (const r of rows) {
      if (r.status === "failed" || r.status === "requires_reconciliation") {
        audit.push({ id: ulid(completed), batchId: id, action: r.status === "failed" ? "item.failed" : "item.requires_reconciliation", createdAt: at(completed), context: { itemId: r.id, reference: r.reference, reason: r.failureReason } });
      }
    }
    if (isFinal) {
      audit.push({ id: ulid(completed + 1), batchId: id, action: `batch.${spec.status}`, createdAt: at(completed + 1), context: { paidCount: count("succeeded"), failedCount: count("failed"), reconciliationCount: count("requires_reconciliation"), ...(txHash ? { simulated: true } : {}) } });
    }
    await db.insert(auditLog).values(audit);
  }
  return { users: DEMO_USERS.length, batches: SPECS.length, skipped: false };
}
