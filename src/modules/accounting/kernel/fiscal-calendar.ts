import type { FiscalYearNaming } from "../packs/pack.types";

/**
 * Fiscal years and periods derived from pack configuration (A8: the calendar is
 * data, not code). All arithmetic is on `YYYY-MM-DD` strings in UTC — an
 * accounting date is a calendar fact, and letting a server timezone near it is
 * how a 1 April invoice lands in the previous fiscal year.
 */

export interface FiscalYearSpan {
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface PeriodSpan {
  name: string;
  startsOn: string;
  endsOn: string;
  sequence: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export class FiscalCalendarError extends Error {}

export function assertIsoDate(value: string): string {
  if (!ISO_DATE.test(value)) {
    throw new FiscalCalendarError(`Not an ISO date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new FiscalCalendarError(`Not a real calendar date: ${value}`);
  }
  return value;
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = assertIsoDate(date).split("-").map(Number);
  return { year, month, day };
}

/** Days in a month, leap years included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add months to a `YYYY-MM-DD`, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return toIso(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return toIso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function compareDates(a: string, b: string): number {
  const left = assertIsoDate(a);
  const right = assertIsoDate(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isWithin(date: string, startsOn: string, endsOn: string): boolean {
  return compareDates(date, startsOn) >= 0 && compareDates(date, endsOn) <= 0;
}

/**
 * The fiscal year containing `date`.
 *
 * India starts 1 April, so 2026-08-25 falls in the year running
 * 2026-04-01 → 2027-03-31, named `2026-27`. A calendar pack starting 1 January
 * names the same span `2026`.
 */
export function fiscalYearFor(
  date: string,
  startMonth: number,
  startDay: number,
  naming: FiscalYearNaming,
): FiscalYearSpan {
  if (startMonth < 1 || startMonth > 12) {
    throw new FiscalCalendarError(`Fiscal year start month out of range: ${startMonth}`);
  }
  if (startDay < 1 || startDay > 28) {
    // Capped at 28 so the start date exists in every month, February included.
    throw new FiscalCalendarError(`Fiscal year start day out of range: ${startDay}`);
  }

  const { year, month, day } = parts(date);
  const startsBefore = month < startMonth || (month === startMonth && day < startDay);
  const startYear = startsBefore ? year - 1 : year;

  const startsOn = toIso(startYear, startMonth, startDay);
  const endsOn = addDays(addMonths(startsOn, 12), -1);

  return { name: fiscalYearName(startsOn, endsOn, naming), startsOn, endsOn };
}

function fiscalYearName(startsOn: string, endsOn: string, naming: FiscalYearNaming): string {
  const start = parts(startsOn);
  if (naming === "calendar") return String(start.year);
  const end = parts(endsOn);
  return `${start.year}-${String(end.year % 100).padStart(2, "0")}`;
}

/** The fiscal year immediately following `span`. */
export function nextFiscalYear(span: FiscalYearSpan, naming: FiscalYearNaming): FiscalYearSpan {
  const startsOn = addDays(span.endsOn, 1);
  const endsOn = addDays(addMonths(startsOn, 12), -1);
  return { name: fiscalYearName(startsOn, endsOn, naming), startsOn, endsOn };
}

/**
 * Twelve monthly periods covering the year exactly — no gap, no overlap, and
 * the last one ends on the fiscal year's own end date.
 */
export function monthlyPeriodsFor(span: FiscalYearSpan): PeriodSpan[] {
  const periods: PeriodSpan[] = [];
  let cursor = assertIsoDate(span.startsOn);

  for (let sequence = 1; sequence <= 12; sequence++) {
    const isLast = sequence === 12;
    const nextStart = addMonths(span.startsOn, sequence);
    const endsOn = isLast ? span.endsOn : addDays(nextStart, -1);
    const { year, month } = parts(cursor);

    periods.push({
      name: `${MONTH_NAMES[month - 1]} ${year}`,
      startsOn: cursor,
      endsOn,
      sequence,
    });

    if (isLast) break;
    cursor = nextStart;
  }

  return periods;
}
