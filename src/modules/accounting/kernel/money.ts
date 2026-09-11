/**
 * Money for the accounting kernel.
 *
 * Two rules the rest of the module depends on:
 *
 * 1. **An amount never travels without its currency.** `Money` is a branded
 *    pair, so a bare `number` cannot be passed where money is expected.
 * 2. **Arithmetic is integer arithmetic.** Amounts are minor units (paise,
 *    cents, yen). Conversion goes through `BigInt` so a rate with ten decimal
 *    places never touches IEEE-754.
 *
 * FX direction is fixed once, here: `rate` multiplies **transaction currency
 * into functional currency**. `functional = txn * rate`, scale-adjusted. PRD 11
 * asks for this to be picked and documented; this is the pick.
 */

/** Scale of the rate column, `numeric(18,10)` in `gl_fx_rates`. */
const RATE_SCALE = 10n;
const RATE_FACTOR = 10n ** RATE_SCALE;

declare const MoneyBrand: unique symbol;

export interface Money {
  readonly minor: number;
  readonly currency: string;
  readonly [MoneyBrand]?: never;
}

/**
 * ISO 4217 minor-unit scales for the currencies a pack can seed. The catalog
 * table `gl_currencies` is the runtime source of truth; this is the bootstrap
 * set and the fallback for pure functions that must not hit the database.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  // zero-decimal
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  UGX: 0,
  XAF: 0,
  XOF: 0,
  // three-decimal
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  // two-decimal (the default)
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  CHF: 2,
  NZD: 2,
  ZAR: 2,
  MYR: 2,
  THB: 2,
  PHP: 2,
  IDR: 2,
  HKD: 2,
  CNY: 2,
  LKR: 2,
  BDT: 2,
  NPR: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  MXN: 2,
  BRL: 2,
  NGN: 2,
  KES: 2,
  TRY: 2,
  ILS: 2,
});

const ISO_4217 = /^[A-Z]{3}$/;

export class MoneyError extends Error {}

/* ------------------------------------------------------------ construction */

export function isCurrencyCode(code: string): boolean {
  return ISO_4217.test(code);
}

export function assertCurrencyCode(code: string): string {
  if (!isCurrencyCode(code)) {
    throw new MoneyError(`Not an ISO 4217 currency code: ${JSON.stringify(code)}`);
  }
  return code;
}

/**
 * Minor units are stored `bigint` in Postgres but read as JS numbers (matching
 * `crm.deals.value_minor`). That is safe to ~9e15 minor units; past it, reads
 * would silently lose precision, so refuse to build such a value at all.
 */
export function assertSafeMinor(minor: number): number {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`Money must be whole minor units, got ${minor}`);
  }
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`Money exceeds safe integer range: ${minor}`);
  }
  return minor;
}

export function money(minor: number, currency: string): Money {
  return { minor: assertSafeMinor(minor), currency: assertCurrencyCode(currency) };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function minorUnitsOf(currency: string): number {
  const scale = CURRENCY_MINOR_UNITS[assertCurrencyCode(currency)];
  if (scale === undefined) {
    throw new MoneyError(`Unknown currency ${currency}; add it to gl_currencies first`);
  }
  return scale;
}

/* -------------------------------------------------------------- arithmetic */

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function absolute(a: Money): Money {
  return money(Math.abs(a.minor), a.currency);
}

export function sum(amounts: readonly Money[], currency: string): Money {
  return amounts.reduce((acc, m) => add(acc, m), zero(currency));
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/* ---------------------------------------------------------------- rounding */

/**
 * Half-up on the absolute value, so -0.5 rounds to -1 the way +0.5 rounds to 1.
 * Banker's rounding is deliberately not offered — tax authorities specify
 * half-up, and a pack that needs something else states it explicitly.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = (absNum * 2n + absDen) / (absDen * 2n);
  return negative ? -quotient : quotient;
}

/** Apply a basis-point rate (1800 bp = 18.00%) to a base, half-up. */
export function applyBasisPoints(base: Money, rateBp: number): Money {
  if (!Number.isInteger(rateBp)) {
    throw new MoneyError(`Basis points must be a whole number, got ${rateBp}`);
  }
  const result = divideRoundHalfUp(BigInt(base.minor) * BigInt(rateBp), 10_000n);
  return money(Number(result), base.currency);
}

/**
 * Recover the tax inside a gross amount: `tax = gross * bp / (10000 + bp)`.
 * Used when a document is flagged tax-inclusive (PRD 02 M10).
 */
export function extractInclusiveTax(gross: Money, rateBp: number): Money {
  if (!Number.isInteger(rateBp)) {
    throw new MoneyError(`Basis points must be a whole number, got ${rateBp}`);
  }
  const result = divideRoundHalfUp(
    BigInt(gross.minor) * BigInt(rateBp),
    10_000n + BigInt(rateBp),
  );
  return money(Number(result), gross.currency);
}

/* --------------------------------------------------------------- FX */

function parseRate(rate: string | number): bigint {
  const text = typeof rate === "number" ? rate.toString() : rate.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`FX rate must be a positive decimal, got ${JSON.stringify(rate)}`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > Number(RATE_SCALE)) {
    throw new MoneyError(`FX rate carries more than ${RATE_SCALE} decimal places: ${text}`);
  }
  const scaled =
    BigInt(whole) * RATE_FACTOR + BigInt(fraction.padEnd(Number(RATE_SCALE), "0") || "0");
  if (scaled <= 0n) throw new MoneyError(`FX rate must be greater than zero, got ${text}`);
  return scaled;
}

/**
 * Convert a transaction amount into functional currency.
 *
 * `functional_minor = round_half_up(txn_minor * rate * 10^(func_scale - txn_scale))`
 *
 * Worked example from PRD 11: $100.00 at 83.25 INR/USD is 10000 cents *
 * 83.25 * 10^(2-2) = 832500 paise. `money.spec.ts` pins this and the
 * cross-scale JPY case.
 */
export function convert(amount: Money, functionalCurrency: string, rate: string | number): Money {
  assertCurrencyCode(functionalCurrency);
  const rateScaled = parseRate(rate);

  if (amount.currency === functionalCurrency) {
    if (rateScaled !== RATE_FACTOR) {
      throw new MoneyError(
        `Same-currency conversion (${amount.currency}) requires rate 1, got ${rate}`,
      );
    }
    return money(amount.minor, functionalCurrency);
  }

  const scaleDiff = minorUnitsOf(functionalCurrency) - minorUnitsOf(amount.currency);
  let numerator = BigInt(amount.minor) * rateScaled;
  let denominator = RATE_FACTOR;
  if (scaleDiff >= 0) {
    numerator *= 10n ** BigInt(scaleDiff);
  } else {
    denominator *= 10n ** BigInt(-scaleDiff);
  }

  return money(Number(divideRoundHalfUp(numerator, denominator)), functionalCurrency);
}

/* ------------------------------------------------------------- allocation */

/**
 * Split an amount across weights without losing or inventing a minor unit —
 * largest-remainder, so the parts always sum back to the whole. Tax spread over
 * invoice lines and a receipt applied across open items both go through here.
 */
export function allocate(amount: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new MoneyError("Cannot allocate across zero weights");
  if (weights.some((w) => w < 0)) throw new MoneyError("Allocation weights must be non-negative");

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    // Nothing to weight by: put it all on the first slot rather than silently
    // dropping it, so callers still see a total that ties.
    return weights.map((_, i) => money(i === 0 ? amount.minor : 0, amount.currency));
  }

  const total = BigInt(amount.minor);
  const weightTotal = BigInt(totalWeight);
  const shares = weights.map((w) => (total * BigInt(w)) / weightTotal);
  let remainder = total - shares.reduce((a, b) => a + b, 0n);

  // Hand the leftover units to the largest fractional parts first.
  const order = weights
    .map((w, index) => ({
      index,
      fraction: (total * BigInt(w)) % weightTotal,
    }))
    .sort((a, b) => (a.fraction === b.fraction ? a.index - b.index : b.fraction > a.fraction ? 1 : -1));

  const step = remainder >= 0n ? 1n : -1n;
  for (const { index } of order) {
    if (remainder === 0n) break;
    shares[index] += step;
    remainder -= step;
  }

  return shares.map((s) => money(Number(s), amount.currency));
}

/* ------------------------------------------------------------ formatting */

/** Decimal string for display and CSV export. Never used for arithmetic. */
export function toDecimalString(amount: Money): string {
  const scale = minorUnitsOf(amount.currency);
  const negative = amount.minor < 0;
  const digits = Math.abs(amount.minor).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale) || "0";
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Parse a user-entered decimal into minor units. Rejects excess precision. */
export function fromDecimalString(value: string, currency: string): Money {
  const scale = minorUnitsOf(currency);
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`Not a decimal amount: ${JSON.stringify(value)}`);
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  if (fraction.length > scale) {
    throw new MoneyError(`${currency} carries ${scale} decimal places, got ${JSON.stringify(value)}`);
  }
  const minor = Number(BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0"));
  return money(negative ? -minor : minor, currency);
}
