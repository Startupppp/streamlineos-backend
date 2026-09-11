/**
 * When a term ends, expressed as arithmetic rather than as a Date.
 *
 * Pure, and pure for one reason: every value here goes into a `date` column that
 * the renewal book sorts on, and a renewal date that is one day out is a renewal
 * conversation that happens after the customer has already decided. This has to
 * be provably right before anything writes it, and a rule that needs a database
 * and a tenant to exercise never gets exercised at the boundaries.
 *
 * Calendar dates, never `Date` objects, and never `setMonth`. `new Date(...)`
 * parses `"2026-01-31"` as UTC midnight and then renders it in the process's
 * zone, so a server west of Greenwich turns every stored date into the day
 * before. And `setMonth(+1)` on 31 January produces 3 March — Postgres's own
 * `+ interval '1 month'` clamps to 28 February, and a renewal book where the
 * application and the database disagree about the same contract is worse than
 * either answer alone.
 */

/** The term used when the deal says nothing. Annual is what a contract usually is. */
export const DEFAULT_TERM_MONTHS = 12;

/** A month-to-month deal at one end, a decade at the other. Anything outside is a typo. */
export const MIN_TERM_MONTHS = 1;
export const MAX_TERM_MONTHS = 120;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
  readonly year: number;
  /** 1-12, not the 0-11 `Date` uses. Nothing here goes near `Date`. */
  readonly month: number;
  readonly day: number;
}

/** Null rather than a throw: an unparseable date is ordinary input, not a fault. */
export function parseIsoDate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

export function formatIsoDate(date: CalendarDate): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Adds whole months, clamping the day to the target month's length.
 *
 * 31 January + 1 month is 28 February (29 in a leap year), matching Postgres.
 * The clamp does not remember: 31 January + 2 months is 31 March, not 28 March,
 * because the term is anchored on the start date rather than walked one month at
 * a time.
 */
export function addMonths(start: CalendarDate, months: number): CalendarDate {
  const zeroBased = start.month - 1 + months;
  const year = start.year + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(start.day, daysInMonth(year, month)) };
}

/** The renewal date of a term starting on `startedOn`. Null if the start is unusable. */
export function renewalDate(startedOn: string, termMonths: number): string | null {
  const start = parseIsoDate(startedOn);
  if (!start) return null;
  if (!Number.isInteger(termMonths)) return null;
  if (termMonths < MIN_TERM_MONTHS || termMonths > MAX_TERM_MONTHS) return null;
  return formatIsoDate(addMonths(start, termMonths));
}

/**
 * The term a deal states, if it states one credibly.
 *
 * Deals carry no term column, so the tenant's own `custom_data` is the only
 * place one can come from. Anything that is not a whole number of months inside
 * the bounds falls back to the default rather than being rejected: a nonsense
 * term in a JSON blob must not be able to stop a won deal from producing a
 * lifecycle record at all, which would lose the revenue from the book entirely
 * in exchange for a typo.
 */
export function termMonthsFrom(customData: unknown): number {
  if (!customData || typeof customData !== "object") return DEFAULT_TERM_MONTHS;

  const stated = (customData as Record<string, unknown>).termMonths;
  const months = typeof stated === "string" ? Number(stated) : stated;

  if (typeof months !== "number" || !Number.isInteger(months)) return DEFAULT_TERM_MONTHS;
  if (months < MIN_TERM_MONTHS || months > MAX_TERM_MONTHS) return DEFAULT_TERM_MONTHS;

  return months;
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/**
 * Days since 1970-01-01 for a calendar date, computed arithmetically.
 *
 * Deliberately not `Date.UTC(...)/86400000`: the difference of two such values
 * is correct, but it invites a caller to build a `Date` from a calendar date
 * somewhere else in the module, which is the timezone bug this file exists to
 * avoid. Howard Hinnant's civil-from-days, run backwards.
 */
function toEpochDay(date: CalendarDate): number {
  const year = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear =
    Math.floor((153 * (date.month + (date.month > 2 ? -3 : 9)) + 2) / 5) + date.day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The calendar date an instant falls on in UTC. One conversion, in one place. */
export function calendarDateOf(instant: Date): CalendarDate {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

/**
 * A calendar date shifted by whole days, forwards or backwards.
 *
 * Here rather than in the caller that needed it, and built on the same
 * `toEpochDay` the rest of this file uses. The alternative — a caller doing
 * `new Date(iso); d.setDate(d.getDate() - 90)` — is the timezone bug this whole
 * module exists to avoid: it parses an ISO date as UTC midnight, shifts it in
 * the host's local zone, and lands on the previous day for every server west of
 * Greenwich. A renewal window that opens a day early on some hosts and not
 * others is the kind of defect nobody reproduces.
 */
export function addDays(start: CalendarDate, days: number): CalendarDate {
  return civilFromDays(toEpochDay(start) + Math.trunc(days));
}

/** Howard Hinnant's civil-from-days, forwards. The inverse of `toEpochDay`. */
function civilFromDays(epochDay: number): CalendarDate {
  const shifted = epochDay + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);

  return { year: month <= 2 ? year + 1 : year, month, day };
}
