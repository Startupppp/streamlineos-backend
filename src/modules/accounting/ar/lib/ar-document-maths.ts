/**
 * The pure arithmetic AR documents run on. Integers throughout; no database.
 */
import { convert, divideRoundHalfUp, money } from "../../kernel/money";

/* -------------------------------------------------------------- line maths */

/**
 * `net = round_half_up(quantity * unit price) - discount`, all in integers.
 *
 * Quantity is thousandths so 2.5 hours is exact, and the multiply happens in
 * `BigInt` before the divide so a 1/3 quantity never rounds twice. Exported
 * because it is pure and worth unit-testing on its own.
 */
export function computeLineNetMinor(
  quantityMilli: number,
  unitPriceMinor: number,
  discountMinor: number,
): number {
  const gross = divideRoundHalfUp(BigInt(quantityMilli) * BigInt(unitPriceMinor), 1000n);
  return Number(gross) - discountMinor;
}

/** `functional = txn * rate`, the one FX direction this module knows (PRD 11). */
export function toFunctional(
  txnMinor: number,
  currency: string,
  baseCurrency: string,
  fxRate: string,
): number {
  if (currency === baseCurrency) return txnMinor;
  return convert(money(txnMinor, currency), baseCurrency, fxRate).minor;
}
