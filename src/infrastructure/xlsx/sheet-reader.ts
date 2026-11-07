/**
 * Reads the first worksheet of an .xlsx into the domain's ParsedSheet.
 * Every cell is read as TEXT and tagged with how Excel stored it, so the domain
 * can reject numeric / scientific-notation amounts and addresses.
 */
import ExcelJS from "exceljs";
import type { Cell, CellKind, ParsedSheet } from "../../domain/withdrawal-rules";

const { ValueType } = ExcelJS;

export function normalizeHeader(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\u00a0/g, " ").trim().toLowerCase();
}

function toCell(cell: ExcelJS.Cell): Cell {
  const v = cell.value;
  switch (cell.type) {
    case ValueType.Null:
    case ValueType.Merge:
      return { text: "", kind: "empty" };
    case ValueType.String:
    case ValueType.SharedString:
      return { text: String(v ?? ""), kind: String(v ?? "").trim() === "" ? "empty" : "text" };
    case ValueType.RichText:
      return { text: (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join(""), kind: "text" };
    case ValueType.Hyperlink:
      return { text: String((v as ExcelJS.CellHyperlinkValue).text ?? ""), kind: "text" };
    case ValueType.Number:
      // `cell.text` is Excel's display form (e.g. "1.23E+40") — exactly what we must reject.
      return { text: cell.text || String(v), kind: "number" };
    case ValueType.Date:
      return { text: cell.text, kind: "date" };
    case ValueType.Boolean:
      return { text: String(v), kind: "boolean" };
    case ValueType.Formula: {
      const result = (v as ExcelJS.CellFormulaValue).result;
      return { text: result === undefined || result === null ? "" : String(result), kind: "formula" };
    }
    default:
      return { text: cell.text ?? "", kind: "other" satisfies CellKind };
  }
}

export class UnreadableWorkbookError extends Error {
  constructor(cause?: unknown) {
    super("Not a readable .xlsx workbook", { cause });
    this.name = "UnreadableWorkbookError";
  }
}

export async function readWithdrawalSheet(data: Uint8Array): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs types expect a Node Buffer; a Uint8Array view over the same bytes works at runtime.
    await wb.xlsx.load(Buffer.from(data.buffer, data.byteOffset, data.byteLength) as unknown as ExcelJS.Buffer);
  } catch (e) {
    throw new UnreadableWorkbookError(e);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new UnreadableWorkbookError();

  const headerByCol = new Map<number, string>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = normalizeHeader(toCell(cell).text);
    if (h) headerByCol.set(col, h);
  });

  const rows: ParsedSheet["rows"] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Record<string, Cell> = {};
    for (const [col, header] of headerByCol) cells[header] = toCell(row.getCell(col));
    rows.push({ row: rowNumber, cells });
  });

  return { headers: [...headerByCol.values()], rows };
}
