/**
 * All-or-nothing validation of a parsed withdrawal sheet. Pure: no I/O.
 * Every problem is reported (not just the first), each with a stable issue code
 * for i18n plus an English message. Row 0 = whole-file problem.
 */
import { isValidAddress, normalizeAddress } from "./address";
import { Amount } from "./amount";
import type { Issue, IssueCode, IssueParams, RowError } from "./errors";
import { CHANNEL_NETWORKS, isAsset, isNetwork, SUPPORTED_ASSETS, type Asset, type Channel, type Network } from "./network";

/** How the cell was stored in Excel. Amounts/addresses must be text cells. */
export type CellKind = "text" | "number" | "date" | "boolean" | "formula" | "empty" | "other";
export interface Cell {
  text: string;
  kind: CellKind;
}

export interface ParsedSheet {
  /** Normalized header names (BOM stripped, trimmed, lower-case), in column order. */
  headers: string[];
  rows: { row: number; cells: Record<string, Cell> }[];
}

export const REQUIRED_COLUMNS = ["reference", "address", "amount", "asset", "network"] as const;
export const OPTIONAL_COLUMNS = ["memo"] as const;

export interface WithdrawalLimits {
  maxRowsByChannel: Record<Channel, number>;
  maxBatchTotal: Amount;
  /** Minimum amount per withdrawal, per channel (MEXC: 1 USDT). */
  minAmountByChannel: Partial<Record<Channel, Amount>>;
  /** Max fraction digits for the asset (USDT: 6). */
  maxDecimals: number;
}

export interface ValidWithdrawal {
  row: number;
  reference: string;
  address: string;
  amount: Amount;
  asset: Asset;
  network: Network;
  memo?: string;
}

export interface SheetValidation {
  valid: boolean;
  rowCount: number;
  totalAmount: Amount;
  asset?: Asset;
  network?: Network;
  errors: RowError[];
  withdrawals: ValidWithdrawal[];
}

const MESSAGES: Record<IssueCode, (p: IssueParams) => string> = {
  "address.invalid": (p) => `"${p.address}" is not a valid ${p.network} address.`,
  "amount.not_positive": (p) => `Amount "${p.value}" must be greater than zero.`,
  "amount.zero": () => "Amount must be greater than zero.",
  "amount.too_precise": (p) => `Amount "${p.value}" has more than ${p.max} decimal places.`,
  "amount.not_number": (p) =>
    p.reason === "numeric_cell"
      ? `Amount must be stored as text, not as an Excel number (got ${p.value}). Format the column as Text.`
      : p.value === ""
        ? "Amount is required."
        : `Amount "${p.value}" is not a well-formed decimal number.`,
  "amount.below_minimum": (p) => `Amount ${p.value} is below the ${p.channel} minimum of ${p.minimum}.`,
  "reference.duplicate": (p) => `Duplicate reference "${p.reference}" (first used on row ${p.firstRow}).`,
  "reference.required": () => "Reference is required.",
  "asset.unsupported": (p) => `Unsupported asset "${p.value}". Supported: ${SUPPORTED_ASSETS.join(", ")}.`,
  "network.unsupported": (p) => `Unsupported network "${p.value}". Use TRC20, BEP20 or ERC20.`,
  "network.unsupported_for_channel": (p) => `${p.network} is not supported by ${p.channel}. Trust Wallet batches are BEP20/ERC20 only.`,
  "file.missing_columns": (p) => `Missing required column(s): ${(p.columns as string[]).join(", ")}.`,
  "file.empty": () => "The file contains no withdrawal rows.",
  "file.duplicate": (p) => `This exact file was already uploaded as batch ${p.batchId}.`,
  "file.mixed_network": (p) => `A batch must use a single network; found ${(p.networks as string[]).join(", ")}.`,
  "file.too_many_rows": (p) => `The file has ${p.count} rows; the maximum for ${p.channel} is ${p.max}.`,
  "file.too_large": (p) => `The file is ${p.size} bytes; the maximum is ${p.max} bytes.`,
  "file.unreadable": () => "The file is not a readable .xlsx workbook.",
  "batch.total_exceeds_limit": (p) => `Batch total ${p.total} exceeds the limit of ${p.limit}.`,
};

export function issueMessage(issue: Issue): string {
  return MESSAGES[issue.code](issue.params ?? {});
}

/** Collects issues per row and renders them as contract RowErrors. */
export class IssueCollector {
  private readonly byRow = new Map<number, Issue[]>();

  add(row: number, code: IssueCode, params?: IssueParams) {
    const list = this.byRow.get(row) ?? [];
    list.push(params ? { code, params } : { code });
    this.byRow.set(row, list);
  }

  get size() {
    return this.byRow.size;
  }

  toRowErrors(): RowError[] {
    return [...this.byRow.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, issues]) => ({ row, issues, messages: issues.map(issueMessage) }));
  }
}

export function fileError(code: IssueCode, params?: IssueParams): RowError {
  const issue: Issue = params ? { code, params } : { code };
  return { row: 0, issues: [issue], messages: [issueMessage(issue)] };
}

const cellText = (cells: Record<string, Cell>, col: string) => (cells[col]?.text ?? "").trim();

export function validateWithdrawalSheet(sheet: ParsedSheet, channel: Channel, limits: WithdrawalLimits): SheetValidation {
  const issues = new IssueCollector();
  const result = (withdrawals: ValidWithdrawal[], rowCount: number, total = Amount.ZERO, asset?: Asset, network?: Network): SheetValidation => {
    const errors = issues.toRowErrors();
    return { valid: errors.length === 0, rowCount, totalAmount: total, asset, network, errors, withdrawals: errors.length ? [] : withdrawals };
  };

  const missing = REQUIRED_COLUMNS.filter((c) => !sheet.headers.includes(c));
  if (missing.length) {
    issues.add(0, "file.missing_columns", { columns: missing });
    return result([], 0);
  }

  const rows = sheet.rows.filter((r) => Object.values(r.cells).some((c) => c.text.trim() !== ""));
  if (rows.length === 0) {
    issues.add(0, "file.empty");
    return result([], 0);
  }
  const maxRows = limits.maxRowsByChannel[channel];
  if (rows.length > maxRows) issues.add(0, "file.too_many_rows", { count: rows.length, max: maxRows, channel });

  const allowedNetworks = CHANNEL_NETWORKS[channel];
  const minimum = limits.minAmountByChannel[channel];
  const seenRefs = new Map<string, number>();
  const networks = new Set<Network>();
  const withdrawals: ValidWithdrawal[] = [];
  const amounts: Amount[] = [];

  for (const { row, cells } of rows) {
    let ok = true;
    const fail = (code: IssueCode, params?: IssueParams) => {
      ok = false;
      issues.add(row, code, params);
    };

    // reference
    const reference = cellText(cells, "reference");
    if (!reference) fail("reference.required");
    else {
      const key = reference.toUpperCase();
      const first = seenRefs.get(key);
      if (first !== undefined) fail("reference.duplicate", { reference, firstRow: first });
      else seenRefs.set(key, row);
    }

    // network
    const networkRaw = cellText(cells, "network").toUpperCase();
    let network: Network | undefined;
    if (!isNetwork(networkRaw)) fail("network.unsupported", { value: cellText(cells, "network") });
    else {
      networks.add(networkRaw);
      if (!allowedNetworks.includes(networkRaw)) fail("network.unsupported_for_channel", { network: networkRaw, channel });
      else network = networkRaw;
    }

    // asset
    const assetRaw = cellText(cells, "asset").toUpperCase();
    if (!isAsset(assetRaw)) fail("asset.unsupported", { value: cellText(cells, "asset") });

    // address — must be a text cell; numeric/scientific cells are never valid addresses
    const addrCell = cells.address;
    const address = cellText(cells, "address");
    if (!address || (addrCell && addrCell.kind !== "text")) {
      fail("address.invalid", { address, network: network ?? networkRaw ?? "" });
    } else if (network && !isValidAddress(network, address)) {
      fail("address.invalid", { address, network });
    }

    // amount — must be a text cell holding a plain decimal
    const amtCell = cells.amount;
    const amountRaw = cellText(cells, "amount");
    let amount: Amount | undefined;
    if (amtCell && amtCell.kind !== "text" && amtCell.kind !== "empty") {
      fail("amount.not_number", { value: amountRaw, reason: "numeric_cell" });
    } else if (/^-\s*\d/.test(amountRaw)) {
      fail("amount.not_positive", { value: amountRaw });
    } else {
      const wellFormed = /^\d+(\.\d+)?$/.test(amountRaw);
      // Check precision on the text first: a well-formed decimal with >18 places can't even become an
      // Amount, but it IS a number, just too precise (it must not be reported as "not a number").
      const significantDecimals = (amountRaw.split(".")[1] ?? "").replace(/0+$/, "").length;
      const parsed = wellFormed && significantDecimals <= limits.maxDecimals ? Amount.tryParse(amountRaw) : null;
      if (wellFormed && significantDecimals > limits.maxDecimals) fail("amount.too_precise", { value: amountRaw, max: limits.maxDecimals });
      else if (!parsed) fail("amount.not_number", { value: amountRaw });
      else if (parsed.isZero()) fail("amount.zero", { value: amountRaw });
      else if (parsed.fractionDigits() > limits.maxDecimals) fail("amount.too_precise", { value: amountRaw, max: limits.maxDecimals });
      else if (minimum && parsed.lt(minimum)) fail("amount.below_minimum", { value: amountRaw, minimum: minimum.toString(), channel });
      else amount = parsed;
    }

    if (ok && amount && network) {
      amounts.push(amount);
      const memo = cellText(cells, "memo");
      withdrawals.push({
        row,
        reference,
        address: normalizeAddress(network, address),
        amount,
        asset: assetRaw as Asset,
        network,
        ...(memo ? { memo } : {}),
      });
    }
  }

  if (networks.size > 1) issues.add(0, "file.mixed_network", { networks: [...networks].sort() });

  const total = Amount.sum(amounts);
  if (total.gt(limits.maxBatchTotal)) {
    issues.add(0, "batch.total_exceeds_limit", { total: total.toString(), limit: limits.maxBatchTotal.toString() });
  }

  const [network] = networks;
  return result(withdrawals, rows.length, total, "USDT", networks.size === 1 ? network : undefined);
}
