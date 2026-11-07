import { describe, expect, it } from "vitest";
import { isValidEvmAddress, isValidTronAddress, normalizeAddress, toChecksumAddress } from "../../src/domain/address";
import { evmAddress, tronAddress } from "../helpers/addresses";

describe("EVM addresses (viem isAddress semantics)", () => {
  const checksummed = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

  it("accepts a correct EIP-55 checksum", () => expect(isValidEvmAddress(checksummed)).toBe(true));

  it("accepts all-lowercase and all-uppercase", () => {
    expect(isValidEvmAddress(checksummed.toLowerCase())).toBe(true);
    expect(isValidEvmAddress("0x" + checksummed.slice(2).toUpperCase())).toBe(true);
  });

  it("rejects a mixed-case address with a bad checksum", () => {
    expect(isValidEvmAddress("0x8ba1f109551bd432803012645Ac136ddd64DBA72")).toBe(false);
  });

  it.each(["", "0x123", "8ba1f109551bD432803012645Ac136ddd64DBA72", "0xZZa1f109551bD432803012645Ac136ddd64DBA72"])("rejects %j", (a) => {
    expect(isValidEvmAddress(a)).toBe(false);
  });

  it("checksums deterministically", () => {
    expect(toChecksumAddress(checksummed.toLowerCase())).toBe(checksummed);
    expect(normalizeAddress("BEP20", checksummed.toLowerCase())).toBe(checksummed);
    expect(isValidEvmAddress(evmAddress(3))).toBe(true);
  });
});

describe("TRON addresses (base58check)", () => {
  it("accepts valid addresses", () => {
    expect(isValidTronAddress(tronAddress(1))).toBe(true);
    expect(isValidTronAddress("TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj")).toBe(true);
  });

  it("rejects a wrong checksum (one character changed)", () => {
    const a = tronAddress(2);
    const flipped = a.slice(0, -1) + (a.endsWith("A") ? "B" : "A");
    expect(isValidTronAddress(flipped)).toBe(false);
  });

  it.each(["", "T123", "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcd0", "AXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"])(
    "rejects %j",
    (a) => {
      expect(isValidTronAddress(a)).toBe(false);
    },
  );
});
