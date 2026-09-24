/**
 * What an agency actually earns on a placement, computed exactly.
 *
 * The middle-office numbers a staffing desk runs on are a bill rate charged to
 * the client, a pay rate owed to the contractor, and the gap between them. The
 * gap was being computed as `Number(billRate) - Number(payRate)` and then
 * `.toFixed(2)`, which is money in binary floating point: at ₹100.10 and
 * ₹33.37 that subtraction is 66.72999999999999, and `.toFixed(2)` rounds the
 * error out of sight rather than out of existence. Over a quarter of placements
 * those cents are a real reconciliation difference against the invoice.
 *
 * So the arithmetic is done in integer paise and only rendered back to a
 * decimal string at the edge. `bill_rate` and `pay_rate` are
 * `decimal(10,2)` columns that postgres-js hands back as strings, so the
 * string is the exact value — parsing it to a float is the only lossy step,
 * and this module does not take it.
 */

/** Exact paise from a `decimal(10,2)` string, or null when absent/malformed. */
export function toPaise(decimalString: string | null | undefined): number | null {
  if (decimalString === null || decimalString === undefined) return null;
  const trimmed = decimalString.trim();
  /*
    Two decimal places at most, because the column stores two. A third would
    mean the column changed under this function, and silently truncating it
    would make the margin disagree with the invoice by a rounding nobody chose.
  */
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" ? -paise : paise;
}

/** Back to the `decimal(10,2)` shape the rest of the system speaks. */
export function fromPaise(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rendered = `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${rendered}` : rendered;
}

export interface Margin {
  /** Bill minus pay, exact, as a decimal string. Null when either rate is absent. */
  marginAmount: string | null;
  /** Margin as a percentage of the bill rate, rounded to one place. */
  marginPercent: number | null;
  /**
   * True when the pay rate exceeds the bill rate. Surfaced rather than left for
   * the reader to notice a minus sign: a desk placing contractors at a loss is
   * the single most expensive thing that can go unnoticed in this table, and it
   * happens through an ordinary data-entry slip.
   */
  negative: boolean;
}

const NO_MARGIN: Margin = { marginAmount: null, marginPercent: null, negative: false };

/**
 * Margin for one submission.
 *
 * Returns nulls rather than zeros when a rate is missing. Zero is a real
 * margin — a placement made at cost — and a desk that cannot tell it apart
 * from "nobody has entered the rates yet" will chase the wrong contracts.
 */
export function marginFor(
  billRate: string | null | undefined,
  payRate: string | null | undefined,
): Margin {
  const bill = toPaise(billRate);
  const pay = toPaise(payRate);
  if (bill === null || pay === null) return NO_MARGIN;

  const marginPaise = bill - pay;
  return {
    marginAmount: fromPaise(marginPaise),
    /*
      Percent of the bill rate, which is what a staffing desk quotes. Percent of
      pay is a different and larger number, and quoting one while the client
      reads the other is how a deal gets signed at the wrong rate. A zero bill
      rate has no percentage at all rather than an infinity.
    */
    marginPercent: bill === 0 ? null : Math.round((marginPaise / bill) * 1000) / 10,
    negative: marginPaise < 0,
  };
}

export interface MarginRollup {
  /** Submissions that carry both rates. */
  priced: number;
  /** Submissions missing a rate, so absent from every total below. */
  unpriced: number;
  totalMargin: string;
  totalBill: string;
  /** Blended margin across the priced submissions. */
  blendedPercent: number | null;
  /** Priced submissions placing a contractor below cost. */
  negativeCount: number;
}

/**
 * The desk-level view across a vendor's submissions.
 *
 * `unpriced` is reported beside the totals rather than folded into them. A
 * blended margin computed over the rows that happen to have rates, presented as
 * the margin, is the number that makes an unprofitable desk look fine.
 */
export function rollUpMargins(
  rows: readonly { billRate: string | null; payRate: string | null }[],
): MarginRollup {
  let priced = 0;
  let unpriced = 0;
  let totalMarginPaise = 0;
  let totalBillPaise = 0;
  let negativeCount = 0;

  for (const row of rows) {
    const bill = toPaise(row.billRate);
    const pay = toPaise(row.payRate);
    if (bill === null || pay === null) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    totalMarginPaise += bill - pay;
    totalBillPaise += bill;
    if (bill - pay < 0) negativeCount += 1;
  }

  return {
    priced,
    unpriced,
    totalMargin: fromPaise(totalMarginPaise),
    totalBill: fromPaise(totalBillPaise),
    blendedPercent:
      totalBillPaise === 0 ? null : Math.round((totalMarginPaise / totalBillPaise) * 1000) / 10,
    negativeCount,
  };
}
