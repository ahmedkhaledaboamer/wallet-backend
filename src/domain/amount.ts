/**
 * Exact decimal money value. Internally a bigint scaled by 10^18; never a JS number.
 * Matches DB columns numeric(36,18). API strings are produced by toString().
 */
export const AMOUNT_SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(AMOUNT_SCALE);
const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export type AmountErrorCode = "not_number" | "too_precise";

export class AmountError extends Error {
  constructor(
    readonly code: AmountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AmountError";
  }
}

export class Amount {
  private constructor(readonly scaled: bigint) {}

  static readonly ZERO = new Amount(0n);

  /** Parses a plain decimal string ("1250.5", "-3", "0.000001"). No exponents, separators or spaces inside. */
  static parse(input: string): Amount {
    if (typeof input !== "string") throw new AmountError("not_number", "Amount must be a string");
    const m = DECIMAL_RE.exec(input.trim());
    if (!m) throw new AmountError("not_number", `"${input}" is not a decimal number`);
    const [, sign, int, frac = ""] = m;
    if (frac.length > AMOUNT_SCALE) {
      const extra = frac.slice(AMOUNT_SCALE);
      if (/[^0]/.test(extra)) throw new AmountError("too_precise", `"${input}" has more than ${AMOUNT_SCALE} decimal places`);
    }
    const scaled = BigInt(int! + frac.slice(0, AMOUNT_SCALE).padEnd(AMOUNT_SCALE, "0"));
    return new Amount(sign ? -scaled : scaled);
  }

  static tryParse(input: string): Amount | null {
    try {
      return Amount.parse(input);
    } catch {
      return null;
    }
  }

  static fromScaled(scaled: bigint): Amount {
    return new Amount(scaled);
  }

  /** From token base units, e.g. (1_500_000n, 6) → 1.5 */
  static fromBaseUnits(units: bigint, decimals: number): Amount {
    assertDecimals(decimals);
    return new Amount(units * 10n ** BigInt(AMOUNT_SCALE - decimals));
  }

  static sum(values: Iterable<Amount>): Amount {
    let total = 0n;
    for (const v of values) total += v.scaled;
    return new Amount(total);
  }

  add(other: Amount): Amount {
    return new Amount(this.scaled + other.scaled);
  }

  sub(other: Amount): Amount {
    return new Amount(this.scaled - other.scaled);
  }

  compare(other: Amount): -1 | 0 | 1 {
    return this.scaled === other.scaled ? 0 : this.scaled < other.scaled ? -1 : 1;
  }

  eq(other: Amount): boolean {
    return this.scaled === other.scaled;
  }
  gt(other: Amount): boolean {
    return this.scaled > other.scaled;
  }
  lt(other: Amount): boolean {
    return this.scaled < other.scaled;
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }
  isPositive(): boolean {
    return this.scaled > 0n;
  }
  isNegative(): boolean {
    return this.scaled < 0n;
  }

  /** Number of significant fraction digits (trailing zeros ignored). */
  fractionDigits(): number {
    const abs = this.scaled < 0n ? -this.scaled : this.scaled;
    const frac = (abs % SCALE_FACTOR).toString().padStart(AMOUNT_SCALE, "0").replace(/0+$/, "");
    return frac.length;
  }

  /** Integer base units for a token with `decimals`. THROWS if that would lose precision. */
  toBaseUnits(decimals: number): bigint {
    assertDecimals(decimals);
    const divisor = 10n ** BigInt(AMOUNT_SCALE - decimals);
    if (this.scaled % divisor !== 0n) {
      throw new AmountError("too_precise", `${this.toString()} has more than ${decimals} decimal places`);
    }
    return this.scaled / divisor;
  }

  /** Canonical decimal string: no trailing fractional zeros ("100.5", "0", "-2.25"). */
  toString(): string {
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;
    const int = (abs / SCALE_FACTOR).toString();
    const frac = (abs % SCALE_FACTOR).toString().padStart(AMOUNT_SCALE, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

function assertDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > AMOUNT_SCALE) {
    throw new RangeError(`Token decimals must be an integer between 0 and ${AMOUNT_SCALE}`);
  }
}
