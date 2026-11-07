import { sha256 } from "@noble/hashes/sha2.js";
import { toChecksumAddress } from "../../src/domain/address";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Deterministic, checksum-valid TRON address for test row i. */
export function tronAddress(i: number): string {
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  for (let k = 1; k < 21; k++) payload[k] = (i * 31 + k * 7) & 0xff;
  const check = sha256(sha256(payload)).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(check, 21);
  return base58Encode(full);
}

/** Deterministic EIP-55 checksummed EVM address for test row i. */
export function evmAddress(i: number): string {
  const body = Array.from({ length: 20 }, (_, k) => ((i * 13 + k * 17 + 1) & 0xff).toString(16).padStart(2, "0")).join("");
  return toChecksumAddress(`0x${body}`);
}
