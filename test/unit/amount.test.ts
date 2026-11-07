import { describe, expect, it } from "vitest";
import { Amount, AmountError } from "../../src/domain/amount";

describe("Amount", () => {
  it("adds exactly: 0.1 + 0.2 = 0.3", () => {
    expect(Amount.parse("0.1").add(Amount.parse("0.2")).toString()).toBe("0.3");
    expect(Amount.parse("0.1").add(Amount.parse("0.2")).eq(Amount.parse("0.3"))).toBe(true);
  });

  it("keeps 18 decimals and values beyond Number precision", () => {
    expect(Amount.parse("9007199254740993.000000000000000001").toString()).toBe("9007199254740993.000000000000000001");
    expect(Amount.parse("1.000000000000000000").toString()).toBe("1");
  });

  it("canonicalizes and sums", () => {
    expect(Amount.parse("007.2500").toString()).toBe("7.25");
    expect(Amount.sum(["125.50", "980", "42.75"].map((s) => Amount.parse(s))).toString()).toBe("1148.25");
    expect(Amount.parse("1").sub(Amount.parse("1.5")).toString()).toBe("-0.5");
  });

  it("compares", () => {
    expect(Amount.parse("1.50").compare(Amount.parse("1.5"))).toBe(0);
    expect(Amount.parse("10").gt(Amount.parse("9.999999"))).toBe(true);
    expect(Amount.parse("0").isZero()).toBe(true);
    expect(Amount.parse("0.000001").fractionDigits()).toBe(6);
  });

  it("converts to and from token base units", () => {
    expect(Amount.parse("2205.74").toBaseUnits(18)).toBe(2205740000000000000000n);
    expect(Amount.parse("1.5").toBaseUnits(6)).toBe(1_500_000n);
    expect(Amount.parse("12").toBaseUnits(0)).toBe(12n);
    expect(Amount.fromBaseUnits(1_500_000n, 6).toString()).toBe("1.5");
  });

  it("toBaseUnits THROWS on extra precision", () => {
    expect(() => Amount.parse("1.0000001").toBaseUnits(6)).toThrow(AmountError);
    expect(() => Amount.parse("0.5").toBaseUnits(0)).toThrow(/decimal places/);
  });

  it("rejects more than 18 significant decimals", () => {
    expect(() => Amount.parse("0.0000000000000000001")).toThrow(AmountError);
    expect(Amount.parse("1.0000000000000000000").toString()).toBe("1");
  });

  it.each(["", " ", "abc", "1e3", "1E-2", "1,000", "1.", ".5", "0x10", "1 000", "--1", "NaN", "Infinity"])("rejects %j", (input) => {
    expect(() => Amount.parse(input)).toThrow(AmountError);
  });

  it("rejects non-string input", () => {
    expect(() => Amount.parse(1.5 as unknown as string)).toThrow(AmountError);
  });

  it("serializes to a JSON string", () => {
    expect(JSON.stringify({ a: Amount.parse("1.10") })).toBe(`{"a":"1.1"}`);
  });
});
