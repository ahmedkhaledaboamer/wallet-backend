import ExcelJS from "exceljs";
import type { BatchRecord, ItemRecord } from "../../domain/ports/payout-repository";

export interface ExportLinks {
  /** Explorer URL for a tx hash on the batch's network (undefined when not applicable). */
  txUrl(hash: string): string | undefined;
}

const iso = (d?: Date) => (d ? d.toISOString() : "");

/**
 * Batch withdrawals as .xlsx: a "Withdrawals" sheet (one row per item, exactly what the
 * table shows) plus a "Batch" summary sheet. Amounts are written as TEXT so they stay exact
 * (no float rounding) and the file can be compared with the original upload.
 */
export async function buildItemsExport(batch: BatchRecord, items: ItemRecord[], links: ExportLinks): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Apexaora Batch Payouts";
  wb.created = new Date();

  const ws = wb.addWorksheet("Withdrawals", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "row", key: "row", width: 6 },
    { header: "reference", key: "reference", width: 24 },
    { header: "address", key: "address", width: 46 },
    { header: "amount", key: "amount", width: 16, style: { numFmt: "@" } },
    { header: "asset", key: "asset", width: 8 },
    { header: "network", key: "network", width: 10 },
    { header: "memo", key: "memo", width: 16 },
    { header: "status", key: "status", width: 24 },
    { header: "provider_reference", key: "providerReference", width: 34 },
    { header: "tx_hash", key: "txHash", width: 68 },
    { header: "explorer_url", key: "explorerUrl", width: 50 },
    { header: "failure_reason", key: "failureReason", width: 50 },
    { header: "processed_at", key: "processedAt", width: 24 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7549AA" } };
  for (const it of items) {
    const hash = it.txHash ?? (/^0x[0-9a-fA-F]{64}$/.test(it.providerReference ?? "") ? it.providerReference : undefined);
    ws.addRow({
      row: it.rowNumber,
      reference: it.reference,
      address: it.address,
      amount: it.amount.toString(),
      asset: batch.asset,
      network: batch.network,
      memo: it.memo ?? "",
      status: it.status,
      providerReference: it.providerReference ?? "",
      txHash: hash ?? "",
      explorerUrl: hash && !batch.simulated && it.status === "succeeded" ? (links.txUrl(hash) ?? "") : "",
      failureReason: it.failureReason ?? "",
      processedAt: iso(it.processedAt),
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const summary = wb.addWorksheet("Batch");
  summary.columns = [{ width: 22 }, { width: 70 }];
  const rows: [string, string | number][] = [
    ["batch_id", batch.id],
    ["channel", batch.channel],
    ["status", batch.status],
    ["asset", batch.asset],
    ["network", batch.network],
    ["total_amount", batch.totalAmount.toString()],
    ["item_count", batch.itemCount],
    ["paid_count", batch.paidCount],
    ["failed_count", batch.failedCount],
    ["reconciliation_count", batch.reconciliationCount],
    ["simulated", batch.simulated ? "yes (dry-run)" : "no"],
    ["tx_hash", batch.txHash ?? ""],
    ["created_by", batch.createdBy.name],
    ["approved_by", batch.approvedBy?.name ?? ""],
    ["executed_by", batch.executedBy?.name ?? ""],
    ["created_at", iso(batch.createdAt)],
    ["approved_at", iso(batch.approvedAt)],
    ["executed_at", iso(batch.executedAt)],
    ["completed_at", iso(batch.completedAt)],
    ["source_file", batch.fileName],
    ["exported_rows", items.length],
    ["exported_at", new Date().toISOString()],
  ];
  for (const r of rows) summary.addRow(r);
  summary.getColumn(1).font = { bold: true };
  summary.getCell("B6").numFmt = "@";

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
