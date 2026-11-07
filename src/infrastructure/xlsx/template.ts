import ExcelJS from "exceljs";

export const TEMPLATE_HEADERS = ["reference", "address", "amount", "asset", "network", "memo"] as const;
export type SheetRowInput = Partial<Record<(typeof TEMPLATE_HEADERS)[number], string | number>>;

/**
 * Builds the withdrawal template (and test fixtures). Amount and address columns
 * are formatted as Text so Excel keeps exact decimals and never shows 1.23E+40.
 */
export async function buildWithdrawalWorkbook(
  rows: SheetRowInput[] = [],
  opts: { headers?: string[]; example?: boolean } = {},
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Apexaora Batch Payouts";
  const ws = wb.addWorksheet("Withdrawals", { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = opts.headers ?? [...TEMPLATE_HEADERS];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const col of [2, 3]) ws.getColumn(col).numFmt = "@";
  [22, 46, 14, 8, 10, 20].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const data = opts.example
    ? [{ reference: "WD-2026-0001", address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", amount: "125.50", asset: "USDT", network: "TRC20", memo: "" }]
    : rows;
  for (const r of data) ws.addRow(TEMPLATE_HEADERS.map((h) => r[h] ?? null));

  if (opts.example) {
    const notes = wb.addWorksheet("Instructions");
    [
      "One row per withdrawal. Keep the header row unchanged.",
      "amount: decimal TEXT, e.g. 125.50 (max 6 decimals). Do not let Excel convert it to a number.",
      "asset: USDT. network: TRC20, BEP20 or ERC20 — one network per file.",
      "Trust Wallet batches: BEP20/ERC20 only, max 200 rows. MEXC: max 1000 rows, min 1 USDT per row.",
      "TESTNET ONLY.",
    ].forEach((l) => notes.addRow([l]));
    notes.getColumn(1).width = 100;
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
