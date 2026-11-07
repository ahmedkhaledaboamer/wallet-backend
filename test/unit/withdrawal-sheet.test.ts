import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { Amount } from "../../src/domain/amount";
import type { Channel } from "../../src/domain/network";
import { validateWithdrawalSheet, type WithdrawalLimits } from "../../src/domain/withdrawal-rules";
import { readWithdrawalSheet } from "../../src/infrastructure/xlsx/sheet-reader";
import { buildWithdrawalWorkbook, type SheetRowInput } from "../../src/infrastructure/xlsx/template";
import { evmAddress, tronAddress } from "../helpers/addresses";

const limits: WithdrawalLimits = {
  maxRowsByChannel: { mexc: 1000, trust_wallet: 200 },
  maxBatchTotal: Amount.parse("250000"),
  minAmountByChannel: { mexc: Amount.parse("1") },
  maxDecimals: 6,
};

async function validate(rows: SheetRowInput[], channel: Channel = "mexc", opts?: { headers?: string[] }) {
  const sheet = await readWithdrawalSheet(await buildWithdrawalWorkbook(rows, opts));
  return validateWithdrawalSheet(sheet, channel, limits);
}

const tron = (i: number, extra: SheetRowInput = {}): SheetRowInput => ({
  reference: `WD-${i}`,
  address: tronAddress(i),
  amount: "10.50",
  asset: "USDT",
  network: "TRC20",
  ...extra,
});

const codes = (r: { errors: { row: number; issues: { code: string }[] }[] }, row: number) =>
  r.errors.find((e) => e.row === row)?.issues.map((i) => i.code) ?? [];

describe("withdrawal sheet validation", () => {
  it("accepts a valid file and sums exactly", async () => {
    const r = await validate([tron(1), tron(2, { amount: "1.1" }), tron(3, { amount: "2.2", memo: "hello" })]);
    expect(r.valid).toBe(true);
    expect(r.rowCount).toBe(3);
    expect(r.totalAmount.toString()).toBe("13.8"); // 1.1 + 2.2 is inexact in floating point
    expect(r.network).toBe("TRC20");
    expect(r.asset).toBe("USDT");
    expect(r.withdrawals.map((w) => w.row)).toEqual([2, 3, 4]);
    expect(r.withdrawals[2]?.memo).toBe("hello");
  });

  it("reports ALL row errors with Excel row numbers, codes and messages", async () => {
    const r = await validate([
      tron(1),
      tron(2, { address: "not-an-address" }), // row 3
      tron(3, { amount: "" }), // row 4
      tron(4, { reference: "WD-1" }), // row 5 duplicate
      tron(5, { amount: "-20", asset: "BTC" }), // row 6
      tron(6, { network: "SOL" }), // row 7
      tron(7, { amount: "1.1234567" }), // row 8
      tron(8, { amount: "0" }), // row 9
      tron(9, { amount: "0.5" }), // row 10 below MEXC minimum
      tron(10, { reference: "" }), // row 11
      tron(11, { amount: "1e3" }), // row 12
    ]);
    expect(r.valid).toBe(false);
    expect(r.withdrawals).toEqual([]);
    expect(codes(r, 3)).toEqual(["address.invalid"]);
    expect(codes(r, 4)).toEqual(["amount.not_number"]);
    expect(codes(r, 5)).toEqual(["reference.duplicate"]);
    expect(codes(r, 6)).toEqual(["asset.unsupported", "amount.not_positive"]);
    expect(codes(r, 7)).toEqual(["network.unsupported"]);
    expect(codes(r, 8)).toEqual(["amount.too_precise"]);
    expect(codes(r, 9)).toEqual(["amount.zero"]);
    expect(codes(r, 10)).toEqual(["amount.below_minimum"]);
    expect(codes(r, 11)).toEqual(["reference.required"]);
    expect(codes(r, 12)).toEqual(["amount.not_number"]);

    const dup = r.errors.find((e) => e.row === 5)!;
    expect(dup.issues[0]).toEqual({ code: "reference.duplicate", params: { reference: "WD-1", firstRow: 2 } });
    expect(dup.messages[0]).toBe('Duplicate reference "WD-1" (first used on row 2).');
    for (const e of r.errors) expect(e.messages).toHaveLength(e.issues.length);
  });

  it("treats references as duplicates case-insensitively", async () => {
    const r = await validate([tron(1, { reference: "wd-a" }), tron(2, { reference: "WD-A" })]);
    expect(codes(r, 3)).toEqual(["reference.duplicate"]);
  });

  it("uses row 0 for missing columns", async () => {
    const r = await validate([], "mexc", { headers: ["reference", "address", "amount"] });
    expect(r.errors).toEqual([
      expect.objectContaining({ row: 0, issues: [{ code: "file.missing_columns", params: { columns: ["asset", "network"] } }] }),
    ]);
  });

  it("uses row 0 for an empty file", async () => {
    const r = await validate([]);
    expect(codes(r, 0)).toEqual(["file.empty"]);
  });

  it("uses row 0 for mixed networks", async () => {
    const r = await validate([tron(1), { reference: "E1", address: evmAddress(1), amount: "5", asset: "USDT", network: "BEP20" }]);
    expect(codes(r, 0)).toEqual(["file.mixed_network"]);
    expect(r.errors[0]?.issues[0]?.params).toEqual({ networks: ["BEP20", "TRC20"] });
  });

  it("enforces the per-channel row limit with row 0", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ reference: `E-${i}`, address: evmAddress(i), amount: "1", asset: "USDT", network: "BEP20" }));
    const trust = await validate(rows, "trust_wallet");
    expect(codes(trust, 0)).toEqual(["file.too_many_rows"]);
    expect(trust.errors[0]?.issues[0]?.params).toEqual({ count: 201, max: 200, channel: "trust_wallet" });
    expect((await validate(rows, "mexc")).valid).toBe(true);
  });

  it("enforces the batch total limit with row 0", async () => {
    const r = await validate([tron(1, { amount: "200000" }), tron(2, { amount: "50000.000001" })]);
    expect(codes(r, 0)).toEqual(["batch.total_exceeds_limit"]);
  });

  it("rejects TRC20 for Trust Wallet", async () => {
    const r = await validate([tron(1)], "trust_wallet");
    expect(codes(r, 2)).toEqual(["network.unsupported_for_channel"]);
  });

  it("validates EVM addresses (lowercase ok, bad mixed-case checksum rejected)", async () => {
    const good = evmAddress(5);
    const bad = good.slice(0, 2) + (good[2] === good[2]!.toUpperCase() ? good[2]!.toLowerCase() : good[2]!.toUpperCase()) + good.slice(3);
    const r = await validate(
      [
        { reference: "A", address: good.toLowerCase(), amount: "1", asset: "USDT", network: "ERC20" },
        { reference: "B", address: /[a-f]/i.test(good[2]!) ? bad : "0xNOTHEX", amount: "1", asset: "usdt", network: "erc20" },
      ],
      "trust_wallet",
    );
    expect(codes(r, 2)).toEqual([]);
    expect(codes(r, 3)).toEqual(["address.invalid"]);
  });

  it("is BOM-safe and case-insensitive on headers", async () => {
    const r = await validate([tron(1)], "mexc", { headers: ["﻿Reference", " ADDRESS ", "Amount", "Asset", "NETWORK", "Memo"] });
    expect(r.valid).toBe(true);
  });

  it("rejects numeric / scientific-formatted amounts and addresses", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("W");
    ws.addRow(["reference", "address", "amount", "asset", "network"]);
    ws.addRow(["N-1", tronAddress(1), 125.5, "USDT", "TRC20"]); // amount stored as a number
    ws.addRow(["N-2", 1.2345678901234568e40, "10", "USDT", "TRC20"]); // address stored as a number (shows 1.23E+40)
    ws.addRow(["N-3", tronAddress(3), { formula: "1+1", result: 2 }, "USDT", "TRC20"]); // formula
    const sheet = await readWithdrawalSheet(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    const r = validateWithdrawalSheet(sheet, "mexc", limits);
    expect(codes(r, 2)).toEqual(["amount.not_number"]);
    expect(r.errors.find((e) => e.row === 2)?.issues[0]?.params).toMatchObject({ reason: "numeric_cell" });
    expect(codes(r, 3)).toEqual(["address.invalid"]);
    expect(codes(r, 4)).toEqual(["amount.not_number"]);
  });

  it("skips fully blank rows", async () => {
    const r = await validate([tron(1), {}, tron(2)]);
    expect(r.valid).toBe(true);
    expect(r.rowCount).toBe(2);
  });

  it("rejects a non-xlsx payload", async () => {
    await expect(readWithdrawalSheet(new TextEncoder().encode("reference,address\n"))).rejects.toThrow(/readable/);
  });

  it("builds a template that itself validates", async () => {
    const sheet = await readWithdrawalSheet(await buildWithdrawalWorkbook([], { example: true }));
    expect(validateWithdrawalSheet(sheet, "mexc", limits).valid).toBe(true);
  });
});
