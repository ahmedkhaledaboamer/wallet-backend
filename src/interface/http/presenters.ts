/** Domain records → the exact JSON shapes of the API CONTRACT (camelCase, amounts as strings, ISO dates). */
import type { AppSettings } from "../../application/settings";
import type { FileValidation } from "../../application/validate-withdrawal-sheet";
import type { Network } from "../../domain/network";
import type { AuditRecord, BatchRecord, DashboardTotals, ItemRecord, UserRecord } from "../../domain/ports/payout-repository";

const iso = (d?: Date) => (d ? d.toISOString() : undefined);
const user = (u?: UserRecord) => (u ? { id: u.id, name: u.name, role: u.role } : undefined);

export function txExplorerUrl(settings: AppSettings, network: Network, hash: string): string | undefined {
  const base = settings.networks.find((n) => n.network === network)?.explorerUrl;
  if (!base) return undefined;
  return network === "TRC20" ? `${base}/transaction/${hash.replace(/^0x/, "")}` : `${base}/tx/${hash}`;
}

export function presentBatch(b: BatchRecord, settings: AppSettings) {
  return {
    id: b.id,
    channel: b.channel,
    status: b.status,
    asset: b.asset,
    network: b.network,
    totalAmount: b.totalAmount.toString(),
    itemCount: b.itemCount,
    paidCount: b.paidCount,
    failedCount: b.failedCount,
    reconciliationCount: b.reconciliationCount,
    createdBy: user(b.createdBy)!,
    approvedBy: user(b.approvedBy),
    executedBy: user(b.executedBy),
    rejectionReason: b.rejectionReason,
    txHash: b.txHash,
    // A simulated (dry-run) hash isn't on any chain, so no explorer link.
    explorerUrl: b.txHash && !b.simulated ? txExplorerUrl(settings, b.network, b.txHash) : undefined,
    simulated: b.simulated || undefined,
    createdAt: iso(b.createdAt)!,
    approvedAt: iso(b.approvedAt),
    executedAt: iso(b.executedAt),
    completedAt: iso(b.completedAt),
  };
}

export function presentItem(i: ItemRecord, batch: BatchRecord, settings: AppSettings) {
  return {
    id: i.id,
    reference: i.reference,
    address: i.address,
    amount: i.amount.toString(),
    memo: i.memo,
    status: i.status,
    providerReference: i.providerReference,
    failureReason: i.failureReason,
    explorerUrl: i.txHash && !batch.simulated && i.status === "succeeded" ? txExplorerUrl(settings, batch.network, i.txHash) : undefined,
    processedAt: iso(i.processedAt),
  };
}

export function presentAudit(a: AuditRecord) {
  return { id: a.id, batchId: a.batchId, action: a.action, actor: user(a.actor), context: a.context, createdAt: a.createdAt.toISOString() };
}

export function presentDashboard(d: DashboardTotals) {
  return {
    totalPaid: d.totalPaid.toString(),
    pendingApprovalCount: d.pendingApprovalCount,
    processingCount: d.processingCount,
    needsReconciliationCount: d.needsReconciliationCount,
    byChannel: d.byChannel.map((c) => ({ channel: c.channel, totalPaid: c.totalPaid.toString(), batchCount: c.batchCount })),
  };
}

export function presentValidation(v: FileValidation) {
  return {
    valid: v.valid,
    rowCount: v.rowCount,
    totalAmount: v.totalAmount.toString(),
    asset: v.valid ? v.asset : undefined,
    network: v.network,
    errors: v.errors,
  };
}

export function presentConfig(s: AppSettings) {
  return {
    environment: s.environment,
    dryRun: s.dryRun,
    networks: s.networks.map((n) => ({ network: n.network, chainId: n.chainId, name: n.name, explorerUrl: n.explorerUrl })),
    maxRows: s.maxRowsByChannel.mexc, // kept for compatibility; per-channel limits below
    maxRowsByChannel: s.maxRowsByChannel,
    maxBatchTotal: s.maxBatchTotal.toString(),
  };
}

export const page = <T>(data: T[], p: { page: number; pageSize: number }, total: number) => ({ data, meta: { page: p.page, pageSize: p.pageSize, total } });
