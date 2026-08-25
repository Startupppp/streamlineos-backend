import { divideRoundHalfUp } from "../kernel/money";

/**
 * Line arithmetic for AP documents.
 *
 * Deliberately identical in shape to AR's: a bill and an invoice are the same
 * document seen from opposite sides, and two implementations of
 * `quantity × price − discount` would eventually disagree by a paisa on a
 * three-way match.
 *
 *   lineNet = round_half_up(quantityMilli / 1000 × unitPriceMinor) − discountMinor
 *
 * Quantity is thousandths so 2.5 hours is exact; the multiply happens in
 * `BigInt` and is rounded once, at the end, so no float ever touches money.
 */
export function computeLineNetMinor(
  quantityMilli: number,
  unitPriceMinor: number,
  discountMinor: number,
): number {
  const gross = divideRoundHalfUp(BigInt(quantityMilli) * BigInt(unitPriceMinor), 1000n);
  return Number(gross) - discountMinor;
}

/** `YYYY-MM` for the return period, derived from the document date at post. */
export function periodKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is
 * earlier. UTC midnights only, so a DST boundary cannot shift a bucket.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

export const AP_AGING_BUCKETS = ["0-30", "31-60", "61-90", "91+"] as const;
export type ApAgingBucket = (typeof AP_AGING_BUCKETS)[number];

/**
 * Which bucket an open item falls in, by days past its due date. Not-yet-due
 * items (a negative age) sit in `0-30` alongside the freshly overdue — that is
 * the "current" column an AP aging report shows first.
 */
export function bucketFor(daysOverdue: number): ApAgingBucket {
  if (daysOverdue <= 30) return "0-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "91+";
}
