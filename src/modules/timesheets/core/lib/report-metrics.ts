export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function utilizationRate(billableHours: number, totalHours: number): number {
  if (totalHours <= 0) return 0;
  return round3(billableHours / totalHours);
}

export function computeMargin(billableAmount: number, costAmount: number | null): number | null {
  if (costAmount === null) return null;
  return round2(billableAmount - costAmount);
}

export function writeOffRate(billableHours: number, nonBillableHours: number): number {
  const total = billableHours + nonBillableHours;
  if (total <= 0) return 0;
  return round3(nonBillableHours / total);
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export function hoursBetween(start: Date, end: Date): number {
  return round1((end.getTime() - start.getTime()) / MS_PER_HOUR);
}

export function daysBetween(start: Date, end: Date): number {
  return round1((end.getTime() - start.getTime()) / MS_PER_DAY);
}

export function averageHours(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

export function parseDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function completeWeeksInRange(startDate: string, endDate: string): number {
  const days =
    Math.floor((parseDateOnly(endDate).getTime() - parseDateOnly(startDate).getTime()) / MS_PER_DAY) + 1;
  if (days <= 0) return 0;
  return Math.floor(days / 7);
}

export const MAX_REPORT_SPAN_DAYS = 366;

export function expectedHoursForRange(
  startDate: string,
  endDate: string,
  expectedWeeklyHours: number | null,
  holidayDates: readonly string[] = [],
  expectedDailyHours: number | null = null,
): number | null {
  const weekly =
    expectedWeeklyHours !== null && Number.isFinite(expectedWeeklyHours)
      ? expectedWeeklyHours
      : expectedDailyHours !== null && Number.isFinite(expectedDailyHours)
        ? expectedDailyHours * 5
        : null;
  if (weekly === null) return null;

  const base = completeWeeksInRange(startDate, endDate) * weekly;
  const workdays = new Set(weekdayDatesInRange(startDate, endDate));
  const lost = new Set(holidayDates.filter((date) => workdays.has(date)));
  const perDay = weekly / 5;

  return round2(Math.max(0, base - lost.size * perDay));
}

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

export function missingWeekdayCount(
  startDate: string,
  endDate: string,
  workedDates: ReadonlySet<string>,
): number {
  return weekdayDatesInRange(startDate, endDate).filter((d) => !workedDates.has(d)).length;
}

export function resolveDateRange(
  startDate?: string,
  endDate?: string,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const end = endDate ?? toDateString(now);
  const start = startDate ?? toDateString(new Date(parseDateOnly(end).getTime() - 29 * MS_PER_DAY));
  const days = Math.floor((parseDateOnly(end).getTime() - parseDateOnly(start).getTime()) / MS_PER_DAY) + 1;
  if (days > MAX_REPORT_SPAN_DAYS) {
    throw new RangeError(
      `Report range cannot exceed ${MAX_REPORT_SPAN_DAYS} days (got ${days})`,
    );
  }
  return { startDate: start, endDate: end };
}

export interface CurrencyAmountInput {
  currency: string;
  billableAmount: number;
  costAmount: number | null;
}

export interface CurrencyAmount {
  currency: string;
  billableAmount: number;
  costAmount: number | null;
  margin: number | null;
}

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
