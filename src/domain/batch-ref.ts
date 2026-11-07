/**
 * On-chain batch reference: the batch UUID's 16 bytes, RIGHT-padded with zeros to bytes32.
 *   3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b → 0x3f2b8c1e9a4d4e5f8b6a1c2d3e4f5a6b00000000000000000000000000000000
 * The same value is returned by /onchain-payload and checked by the verifier (topics[1]).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidToBatchRef(uuid: string): `0x${string}` {
  if (!UUID_RE.test(uuid)) throw new RangeError(`Not a UUID: ${uuid}`);
  return `0x${uuid.replace(/-/g, "").toLowerCase().padEnd(64, "0")}`;
}

export function batchRefToUuid(ref: string): string | null {
  if (!/^0x[0-9a-fA-F]{32}0{32}$/.test(ref)) return null;
  const h = ref.slice(2, 34).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const sameBatchRef = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
