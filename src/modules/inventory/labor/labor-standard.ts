/**
 * NEO-7 - what a piece of floor work should take, and how to read what it did.
 *
 * ## What this is not
 *
 * It is **not** an engineered labour standard. Manhattan and Blue Yonder build
 * those from a surveyed building and a time study - travel speeds per aisle,
 * reach heights, case weights - and calling this the same thing would be a
 * claim the data cannot support. It is a **lite** standard: a fixed setup cost,
 * a per-scan cost and a per-bin-change cost, with numbers a supervisor can see
 * and argue with.
 *
 * It is also **not payroll**. Nothing here is a rate or an amount, and no caller
 * may turn it into one inside this module: a warehouse measuring pick rates and
 * a business paying piece rates are different systems, and the second needs
 * grievance, correction and consent that a stock module has no business
 * improvising. `__tests__/labor.spec.ts` asserts the module writes no pay table.
 *
 * ## The numbers
 *
 * Chosen to be legible rather than precise, and stored on every record so a
 * later change to them cannot silently restate last month's performance.
 */
export const LABOR_STANDARD = {
  /** Reading the task, orienting, confirming. Every line pays this once. */
  setupSeconds: 20,
  /** A scan is a deliberate act: find the label, aim, wait for the beep. */
  perScanSeconds: 6,
  /** One bin change. See `distanceProxy` in `labor.ts` for why this is not metres. */
  perBinChangeSeconds: 25,
  /** Per unit handled, above the first. Picking twelve is not twelve times picking one. */
  perUnitSeconds: 2,
} as const;

export interface LaborInputs {
  scanCount: number;
  distanceProxy: number;
  unitsDone: string;
}

/**
 * The standard for one line, in whole seconds, never below one.
 *
 * Floored at one because a standard of zero makes performance a division by zero
 * and every board that reads it shows infinity beside a real person's name.
 */
export function standardSecondsFor(inputs: LaborInputs): number {
  const units = Math.max(0, Number(inputs.unitsDone));
  const seconds =
    LABOR_STANDARD.setupSeconds +
    Math.max(0, inputs.scanCount) * LABOR_STANDARD.perScanSeconds +
    Math.max(0, inputs.distanceProxy) * LABOR_STANDARD.perBinChangeSeconds +
    Math.max(0, units - 1) * LABOR_STANDARD.perUnitSeconds;

  return Math.max(1, Math.round(seconds));
}

export interface LaborTotals {
  userId: string;
  lines: number;
  unitsDone: number;
  actualSeconds: number;
  standardSeconds: number;
}

export interface LaborPerformance extends LaborTotals {
  /**
   * Standard over actual, as a percentage. 100 means on standard, above means
   * faster than standard.
   *
   * This direction round on purpose: "112%" reading as *better* is what every
   * warehouse already means by performance, and inverting it here would make
   * every conversation about this board start with an explanation.
   */
  performancePct: number;
  /** Units per hour. Null when nothing was done, never zero-divided. */
  unitsPerHour: number | null;
}

export function performanceOf(totals: LaborTotals): LaborPerformance {
  const performancePct =
    totals.actualSeconds > 0
      ? Math.round((totals.standardSeconds / totals.actualSeconds) * 10_000) / 100
      : 0;

  const unitsPerHour =
    totals.actualSeconds > 0
      ? Math.round((totals.unitsDone / (totals.actualSeconds / 3600)) * 100) / 100
      : null;

  return { ...totals, performancePct, unitsPerHour };
}

/**
 * The gap between two consecutive lines, as a proxy for walking.
 *
 * One if the bin changed, zero if it did not. A picker taking eight units off
 * one shelf walked once; one visiting eight bins walked eight times, and that
 * difference is the whole of what this measures. The first line of a task counts
 * as a move, because the operator had to get there.
 */
export function binChangesBetween(
  previousLocationId: number | null,
  currentLocationId: number | null,
): number {
  if (currentLocationId === null) return 0;
  if (previousLocationId === null) return 1;
  return previousLocationId === currentLocationId ? 0 : 1;
}
