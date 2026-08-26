/**
 * When a message from a machine is allowed to arrive.
 *
 * In the party's own timezone where we know it, and the tenant's where we do
 * not — which is ticket 08's second criterion and the one most easily got
 * subtly wrong. A follow-up written by a system in Bengaluru and read by a
 * customer in California at two in the morning is the same mistake as sending
 * it on a Sunday, and "we sent it during OUR working hours" is not a defence
 * the customer will find interesting.
 *
 * Pure, and built on `Intl` rather than a timezone library on purpose: the
 * runtime's own tz database is the one thing here guaranteed to know that this
 * year's DST transition moved.
 */

export interface WorkingHours {
  /** Local hour the window opens, inclusive. */
  readonly startHour: number;
  /** Local hour it closes, exclusive — 17 means the last minute is 16:59. */
  readonly endHour: number;
  /** ISO weekdays that count as working days: 1 = Monday … 7 = Sunday. */
  readonly days: readonly number[];
}

/**
 * Not a setting.
 *
 * Ticket 08's last criterion is that none of these are things a tenant can
 * override, so the window is a constant rather than a column. A tenant that
 * wants to mail its customers at midnight is not expressing a preference, it is
 * asking the platform to damage its own sending reputation and the customer's
 * opinion of it, and the answer is no.
 */
export const OUTBOUND_WORKING_HOURS: WorkingHours = {
  startHour: 9,
  endHour: 17,
  days: [1, 2, 3, 4, 5],
};

export interface LocalParts {
  /** 1 = Monday … 7 = Sunday, matching ISO-8601. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Falls back to UTC on a timezone the runtime does not recognise.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unknown zone, and a party's
 * timezone can arrive from an import, so the throwing path is reachable from
 * data. Throwing here would take out the send with a 500; resolving to UTC
 * keeps the guardrail working with a window that is merely wrong for one
 * recipient, and the caller records which zone it actually used.
 */
export function localParts(instant: Date, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  }

  const find = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: WEEKDAY_INDEX[find("weekday")] ?? 1,
    hour: Number(find("hour")),
    minute: Number(find("minute")),
  };
}

/** Whether the runtime recognises the zone at all, so a caller can say so. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isWithinWorkingHours(
  instant: Date,
  timeZone: string,
  hours: WorkingHours = OUTBOUND_WORKING_HOURS,
): boolean {
  const local = localParts(instant, timeZone);
  if (!hours.days.includes(local.weekday)) return false;
  return local.hour >= hours.startHour && local.hour < hours.endHour;
}

const QUARTER_HOUR_MS = 15 * 60_000;
/** Eight days, so a Friday evening plus a two-day public holiday still resolves. */
const SEARCH_HORIZON_MS = 8 * 86_400_000;

/**
 * The next instant the window is open, or `instant` itself if it already is.
 *
 * Stepped in quarter-hours rather than computed from an offset, because an
 * offset is exactly the thing that changes underneath this: every real zone is
 * a whole number of quarter-hours from UTC, so a quarter-hour walk cannot step
 * over an opening, and asking `Intl` at each step means DST is handled by the
 * only component that actually knows about it.
 *
 * The result is then snapped back to the opening minute, so a window that opens
 * at 09:00 produces 09:00 and not 09:14 — a fifteen-minute lie in a countdown a
 * person is watching is worse than the arithmetic saved.
 */
export function nextOpening(
  instant: Date,
  timeZone: string,
  hours: WorkingHours = OUTBOUND_WORKING_HOURS,
): Date {
  if (isWithinWorkingHours(instant, timeZone, hours)) return instant;

  const deadline = instant.getTime() + SEARCH_HORIZON_MS;

  for (let at = instant.getTime() + QUARTER_HOUR_MS; at <= deadline; at += QUARTER_HOUR_MS) {
    const candidate = new Date(at);
    if (!isWithinWorkingHours(candidate, timeZone, hours)) continue;

    const local = localParts(candidate, timeZone);
    const snapped = new Date(at - local.minute * 60_000 - (candidate.getSeconds() * 1000));

    // Only snap back to something that is still in the future and still open.
    if (
      snapped.getTime() >= instant.getTime() &&
      isWithinWorkingHours(snapped, timeZone, hours)
    )
      return snapped;

    return candidate;
  }

  /**
   * Nothing open in eight days means the window is unsatisfiable — an empty
   * `days`, or a start at or after the end. Returning the horizon rather than
   * looping forever turns a misconfiguration into a visibly late send rather
   * than a hung workflow, and the constant above is the only configuration this
   * file has, so it cannot happen from data.
   */
  return new Date(deadline);
}
