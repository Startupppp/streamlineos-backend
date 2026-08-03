// Pure, dependency-free metric math for timesheet reports.
// Every function is deterministic and unit-tested in report-metrics.spec.ts.
// All date-only strings are YYYY-MM-DD and interpreted in UTC.

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Billable utilization = billableHours / totalHours (0 when totalHours is 0), 3 decimals. */
export function utilizationRate(billableHours: number, totalHours: number): number {
  if (totalHours <= 0) return 0;
  return round3(billableHours / totalHours);
}

/** Margin = billableAmount - costAmount. Null when cost is unknown (no cost-rate rows). */
export function computeMargin(billableAmount: number, costAmount: number | null): number | null {
  if (costAmount === null) return null;
  return round2(billableAmount - costAmount);
}

/** Write-off rate = nonBillableHours / (billableHours + nonBillableHours), 0 when no hours, 3 decimals. */
export function writeOffRate(billableHours: number, nonBillableHours: number): number {
  const total = billableHours + nonBillableHours;
  if (total <= 0) return 0;
  return round3(nonBillableHours / total);
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Elapsed time between two timestamps in hours, 1 decimal. */
export function hoursBetween(start: Date, end: Date): number {
  return round1((end.getTime() - start.getTime()) / MS_PER_HOUR);
}

/** Elapsed time between two timestamps in days, 1 decimal. */
export function daysBetween(start: Date, end: Date): number {
  return round1((end.getTime() - start.getTime()) / MS_PER_DAY);
}

/** Arithmetic mean rounded to 1 decimal; null for an empty list (no data, not zero). */
export function averageHours(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Parse a YYYY-MM-DD string as UTC midnight. */
export function parseDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

/** Format a Date as its UTC YYYY-MM-DD date. */
export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Number of complete weeks in the inclusive range = floor(inclusiveDays / 7). 0 for inverted ranges. */
export function completeWeeksInRange(startDate: string, endDate: string): number {
  const days =
    Math.floor((parseDateOnly(endDate).getTime() - parseDateOnly(startDate).getTime()) / MS_PER_DAY) + 1;
  if (days <= 0) return 0;
  return Math.floor(days / 7);
}

/**
 * Expected hours for the range = completeWeeksInRange * expectedWeeklyHours.
 * Null when expectedWeeklyHours is not configured.
 */
export function expectedHoursForRange(
  startDate: string,
  endDate: string,
  expectedWeeklyHours: number | null,
): number | null {
  if (expectedWeeklyHours === null || !Number.isFinite(expectedWeeklyHours)) return null;
  return round2(completeWeeksInRange(startDate, endDate) * expectedWeeklyHours);
}

/** All Monday-Friday dates in the inclusive range, as YYYY-MM-DD strings (UTC). */
export function weekdayDatesInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const end = parseDateOnly(endDate).getTime();
  for (let t = parseDateOnly(startDate).getTime(); t <= end; t += MS_PER_DAY) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(toDateString(d));
  }
  return out;
}

/** Count of Monday-Friday dates in the range not present in the worked-dates set. */
export function missingWeekdayCount(
  startDate: string,
  endDate: string,
  workedDates: ReadonlySet<string>,
): number {
  return weekdayDatesInRange(startDate, endDate).filter((d) => !workedDates.has(d)).length;
}

/**
 * Resolve a report date range. Defaults to the last 30 days (inclusive) ending today (UTC):
 * endDate defaults to today, startDate defaults to endDate - 29 days.
 */
export function resolveDateRange(
  startDate?: string,
  endDate?: string,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const end = endDate ?? toDateString(now);
  const start = startDate ?? toDateString(new Date(parseDateOnly(end).getTime() - 29 * MS_PER_DAY));
  return { startDate: start, endDate: end };
}

export interface CurrencyAmountInput {
  currency: string;
  billableAmount: number;
  /** Null means no cost-rate information for these rows. */
  costAmount: number | null;
}

export interface CurrencyAmount {
  currency: string;
  billableAmount: number;
  costAmount: number | null;
  margin: number | null;
}

/**
 * Merge per-currency amount rows: amounts are summed per currency; costAmount stays null
 * only when every contributing row lacks cost data; margin = billableAmount - costAmount
 * (null when costAmount is null). Result is sorted by currency code.
 */
export function currencyBreakdown(rows: CurrencyAmountInput[]): CurrencyAmount[] {
  const byCurrency = new Map<string, { billableAmount: number; costAmount: number | null }>();
  for (const row of rows) {
    const acc = byCurrency.get(row.currency) ?? { billableAmount: 0, costAmount: null };
    acc.billableAmount += row.billableAmount;
    if (row.costAmount !== null) {
      acc.costAmount = (acc.costAmount ?? 0) + row.costAmount;
    }
    byCurrency.set(row.currency, acc);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => {
      const billableAmount = round2(acc.billableAmount);
      const costAmount = acc.costAmount === null ? null : round2(acc.costAmount);
      return {
        currency,
        billableAmount,
        costAmount,
        margin: computeMargin(billableAmount, costAmount),
      };
    });
}
