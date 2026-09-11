/**
 * Withholding rates as **dated configuration data** (PRD 03 S3).
 *
 * Nothing in `india-tds.engine.ts` or `generic-wht.engine.ts` knows a number.
 * Every rate, threshold and section lives here as a row with an effective
 * window, so a Finance Act change is an edit to a table (and, later, rows in a
 * tenant-editable table seeded from this list) rather than a code change that
 * would silently rewrite last year's deductions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠ AS OF 2026-08 — ILLUSTRATIVE ONLY. VERIFY BEFORE RELYING ON THIS.
 *
 * These figures are the commonly-cited headline rates (contractor 1% for an
 * individual/HUF and 2% otherwise, professional fees 10%, technical services
 * 2%) and round-number thresholds. They are a working default so a book is not
 * empty on day one — they are **not** tax advice and they are **not** verified
 * against a current CBDT notification.
 *
 * `paymentCode` carries the Income Tax Act 2025 §393 identifier. The Act
 * consolidates the old Chapter XVII-B sections into one section with tables, and
 * the operative code strings below are **placeholders in the shape the schema
 * expects**, pending the notified code list. `legacySection` (194C, 194J, …) is
 * the value Indian practice, vendor masters and challans still speak, which is
 * exactly why `ap_withholding` stores both.
 *
 * Confirm every row against incometaxindia.gov.in before a tenant files on it.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface WithholdingRateRow {
  /** Registry key of the engine that owns this row. */
  regime: string;
  /** Chapter XVII-B section, or a generic handle. */
  legacySection: string;
  /** Income Tax Act 2025 §393 payment code (or generic equivalent). */
  paymentCode: string;
  label: string;
  /** Default rate in basis points. 1000 = 10.00%. */
  rateBp: number;
  /** Rate where the payee is an individual or HUF, when it differs. */
  individualRateBp?: number;
  /** Penal rate when no PAN / tax id is on file. */
  noTaxIdRateBp?: number;
  /** Nothing is withheld on a single payment below this, in minor units. */
  singleThresholdMinor?: number;
  /** …unless payments to this payee in the year have passed this aggregate. */
  annualThresholdMinor?: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

/** ₹1 = 100 paise. Thresholds below are written in rupees for readability. */
const rupees = (amount: number) => amount * 100;

/**
 * India TDS. See the warning at the top of this file — illustrative, dated,
 * and to be replaced by notified values.
 */
export const INDIA_TDS_RATES: readonly WithholdingRateRow[] = Object.freeze([
  {
    regime: "INDIA_TDS",
    legacySection: "194C",
    paymentCode: "393/T2/CONTRACT",
    label: "Payments to contractors and sub-contractors",
    rateBp: 200,
    individualRateBp: 100,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(30_000),
    annualThresholdMinor: rupees(100_000),
    effectiveFrom: "2000-04-01",
  },
  {
    regime: "INDIA_TDS",
    legacySection: "194J",
    paymentCode: "393/T2/PROFESSIONAL",
    label: "Fees for professional services",
    rateBp: 1000,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(50_000),
    annualThresholdMinor: rupees(50_000),
    effectiveFrom: "2000-04-01",
  },
  {
    regime: "INDIA_TDS",
    legacySection: "194J-TS",
    paymentCode: "393/T2/TECHNICAL",
    label: "Fees for technical services",
    rateBp: 200,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(50_000),
    annualThresholdMinor: rupees(50_000),
    effectiveFrom: "2000-04-01",
  },
  {
    regime: "INDIA_TDS",
    legacySection: "194I-B",
    paymentCode: "393/T2/RENT-BUILDING",
    label: "Rent — land, building or furniture",
    rateBp: 1000,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(50_000),
    annualThresholdMinor: rupees(240_000),
    effectiveFrom: "2000-04-01",
  },
  {
    regime: "INDIA_TDS",
    legacySection: "194I-A",
    paymentCode: "393/T2/RENT-PLANT",
    label: "Rent — plant and machinery",
    rateBp: 200,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(50_000),
    annualThresholdMinor: rupees(240_000),
    effectiveFrom: "2000-04-01",
  },
  {
    regime: "INDIA_TDS",
    legacySection: "194H",
    paymentCode: "393/T2/COMMISSION",
    label: "Commission or brokerage",
    rateBp: 200,
    noTaxIdRateBp: 2000,
    singleThresholdMinor: rupees(20_000),
    annualThresholdMinor: rupees(20_000),
    effectiveFrom: "2000-04-01",
  },
]);

/**
 * A jurisdiction-neutral set for everywhere without a real pack. Flat rates, no
 * thresholds, no payee-type split — enough for a book that only ever withholds
 * a headline percentage from a foreign supplier.
 */
export const GENERIC_WHT_RATES: readonly WithholdingRateRow[] = Object.freeze([
  {
    regime: "GENERIC_WHT",
    legacySection: "WHT_5",
    paymentCode: "WHT/5",
    label: "Withholding tax 5%",
    rateBp: 500,
    effectiveFrom: "2000-01-01",
  },
  {
    regime: "GENERIC_WHT",
    legacySection: "WHT_10",
    paymentCode: "WHT/10",
    label: "Withholding tax 10%",
    rateBp: 1000,
    effectiveFrom: "2000-01-01",
  },
  {
    regime: "GENERIC_WHT",
    legacySection: "WHT_15",
    paymentCode: "WHT/15",
    label: "Withholding tax 15%",
    rateBp: 1500,
    effectiveFrom: "2000-01-01",
  },
  {
    regime: "GENERIC_WHT",
    legacySection: "WHT_20",
    paymentCode: "WHT/20",
    label: "Withholding tax 20%",
    rateBp: 2000,
    effectiveFrom: "2000-01-01",
  },
]);

/**
 * Rows of one regime in force on a date. The date filter is the point: a rate
 * added for next April simply is not returned for a payment made today.
 */
export function ratesInForce(
  rows: readonly WithholdingRateRow[],
  onDate: string,
): WithholdingRateRow[] {
  return rows.filter(
    (r) => r.effectiveFrom <= onDate && (r.effectiveTo == null || r.effectiveTo >= onDate),
  );
}

/** Match on either identifier, so a vendor coded `194J` or `393/T2/…` resolves. */
export function findRate(
  rows: readonly WithholdingRateRow[],
  code: string,
  onDate: string,
): WithholdingRateRow | null {
  const wanted = code.trim().toUpperCase();
  const candidates = ratesInForce(rows, onDate).filter(
    (r) => r.legacySection.toUpperCase() === wanted || r.paymentCode.toUpperCase() === wanted,
  );
  // Latest window wins, so a superseding row shadows the one it replaced.
  return (
    candidates.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null
  );
}
