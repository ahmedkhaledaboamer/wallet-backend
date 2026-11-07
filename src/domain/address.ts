import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Network } from "./network";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** EIP-55 checksummed form of a 0x address (input must already be 40 hex chars). */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = hex(keccak_256(utf8(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  return out;
}

/**
 * Same rule as viem's isAddress: all-lowercase or all-uppercase hex is accepted;
 * the EIP-55 checksum is enforced only when the address is mixed-case.
 */
export function isValidEvmAddress(address: string): boolean {
  if (!HEX40.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function base58Decode(input: string): Uint8Array | null {
  let n = 0n;
  for (const c of input) {
    const v = B58_MAP.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of input) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** TRON address: base58check of 0x41 + 20-byte account id, with a 4-byte double-sha256 checksum. */
export function isValidTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return false;
  const payload = raw.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return checksum.every((b, i) => b === raw[21 + i]);
}

export function isValidAddress(network: Network, address: string): boolean {
  return network === "TRC20" ? isValidTronAddress(address) : isValidEvmAddress(address);
}

/** Canonical stored form: checksummed for EVM, unchanged for TRON. */
export function normalizeAddress(network: Network, address: string): string {
  return network === "TRC20" ? address : toChecksumAddress(address);
}
