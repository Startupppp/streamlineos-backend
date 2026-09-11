/**
 * When a scheduled report runs next.
 *
 * Pure, and its own module, because "when is this due again" is the one part of
 * scheduling that is easy to get subtly wrong and impossible to argue with once
 * it is buried in a sweep: the failure modes are a report that fires twice, one
 * that skips a period, and one that drifts an hour later every week. None of
 * those show up in a green integration test, and all three are decidable here.
 */

export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export interface CadenceSpec {
  readonly cadence: ReportCadence;
  /** 0-23, in the organisation's own zone. */
  readonly hour: number;
  /** 0 (Sunday) - 6, read only by `weekly`. */
  readonly dayOfWeek: number;
  /** 1-28, read only by `monthly`. Capped at 28 — see below. */
  readonly dayOfMonth: number;
}

export function isReportCadence(value: string): value is ReportCadence {
  return (REPORT_CADENCES as readonly string[]).includes(value);
}

/**
 * The highest day-of-month a schedule may name.
 *
 * 29, 30 and 31 are refused rather than clamped. A schedule set to "the 31st"
 * either skips February entirely or silently becomes "the 28th" for one month a
 * year, and both are a report that did not arrive when somebody was told it
 * would. Refusing at the boundary makes the operator choose which they meant.
 */
export const MAX_DAY_OF_MONTH = 28;

const HOUR_MS = 3_600_000;

/**
 * The next occurrence strictly after `after`, in the given zone.
 *
 * Strictly after, never at, and that is the property that stops a report firing
 * twice: the sweep advances `next_run_at` from the value it just consumed, so an
 * implementation that could return the same instant would leave the row due
 * again on the following tick and deliver the same report until the clock moved
 * past it.
 *
 * The zone is the organisation's, not the server's. A daily report at 08:00 for
 * a Delhi tenant must arrive at 08:00 in Delhi in January and in July; computing
 * it in UTC puts it an hour out for every tenant that observes daylight saving,
 * twice a year, which reads as the schedule quietly breaking.
 */
export function nextRunAt(spec: CadenceSpec, after: Date, timeZone: string): Date {
  const zone = safeZone(timeZone);
  /**
   * Walk forward a day at a time and ask the zone where each candidate lands.
   *
   * Arithmetic on a UTC instant cannot answer "08:00 local tomorrow" across a
   * daylight-saving boundary, because tomorrow is 23 or 25 hours away rather
   * than 24. Generating candidates and letting `Intl` say what local time each
   * one is means the answer is the zone's, and the loop is bounded by a year so
   * a zone that never satisfies the spec fails loudly rather than hanging.
   */
  const MAX_DAYS = 400;
  for (let dayOffset = 0; dayOffset <= MAX_DAYS; dayOffset += 1) {
    const candidate = atLocalHour(after, dayOffset, spec.hour, zone);
    if (candidate.getTime() <= after.getTime()) continue;
    if (matchesCadence(spec, candidate, zone)) return candidate;
  }
  throw new Error(`no run time within a year satisfies this cadence in ${zone}`);
}

function matchesCadence(spec: CadenceSpec, candidate: Date, zone: string): boolean {
  if (spec.cadence === "daily") return true;
  const parts = localParts(candidate, zone);
  if (spec.cadence === "weekly") return parts.weekday === spec.dayOfWeek;
  return parts.day === spec.dayOfMonth;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    /** `24` is how `hour12: false` spells midnight in some locales. */
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    weekday: WEEKDAYS.indexOf(value("weekday") as (typeof WEEKDAYS)[number]),
  };
}

/**
 * The instant at which local time in `zone` is `hour:00` on the day `dayOffset`
 * days after `from`.
 *
 * Two passes rather than one: the first guess is off by the zone's offset, and
 * measuring the error against the zone and correcting is what makes this right
 * across a daylight-saving change instead of an hour out for half the year.
 */
function atLocalHour(from: Date, dayOffset: number, hour: number, zone: string): Date {
  let guess = new Date(from.getTime() + dayOffset * 24 * HOUR_MS);
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = localParts(guess, zone);
    const driftMs = (parts.hour - hour) * HOUR_MS + parts.minute * 60_000;
    if (driftMs === 0) return guess;
    guess = new Date(guess.getTime() - driftMs);
  }
  return guess;
}

/**
 * A zone the runtime recognises, or UTC.
 *
 * tzdata drops zones, and a schedule saved under one that has since gone must
 * not throw inside a sweep that is iterating every organisation — one bad row
 * would stop every other tenant's reports. UTC is the honest fallback here
 * rather than a guess at what was meant.
 */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}
