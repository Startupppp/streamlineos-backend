/**
 * Turning an attendance row into time somebody actually worked.
 *
 * This is deliberately a pure function with no database in it, because the
 * arithmetic is where the mistakes are and the arithmetic is what TS-09 would
 * turn into draft timesheet entries. A wrong number here does not look wrong —
 * it looks like a slightly different working day.
 */

export interface RawBreak {
  start: string;
  end?: string;
}

export interface RawAttendance {
  date: string;
  checkIn: Date | string | null;
  checkOut: Date | string | null;
  breaks: RawBreak[] | null;
  autoCheckedOut?: boolean;
  status?: string;
}

export interface ClockSegment {
  date: string;
  startedAt: string;
  endedAt: string;
  breakMinutes: number;
  netMinutes: number;
  /** The clock was closed by a sweep, not by the person. Treat the end as approximate. */
  autoCheckedOut: boolean;
}

const MINUTE = 60_000;

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Total minutes covered by the breaks, clamped to the working window and
 * merged so overlaps are not counted twice.
 *
 * Every clause here is a real shape the column can hold. `breaks` is free-form
 * jsonb written by the attendance UI: a break can be open (no `end`, because
 * the person never came back before checkout), can start before the check-in
 * or run past the check-out (a clock corrected afterwards), and two can
 * overlap (a double tap on the break button). Summing the raw durations gets
 * every one of those wrong, and the error is always in the same direction —
 * it deducts time that was worked.
 */
export function breakMinutesWithin(
  breaks: readonly RawBreak[] | null | undefined,
  windowStart: number,
  windowEnd: number,
): number {
  if (!breaks || breaks.length === 0) return 0;

  const spans: Array<[number, number]> = [];
  for (const b of breaks) {
    const start = toMs(b.start);
    if (start === null) continue;
    /** An unended break ran until the clock closed. */
    const end = toMs(b.end ?? null) ?? windowEnd;
    const clampedStart = Math.max(start, windowStart);
    const clampedEnd = Math.min(end, windowEnd);
    if (clampedEnd > clampedStart) spans.push([clampedStart, clampedEnd]);
  }
  if (spans.length === 0) return 0;

  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
      continue;
    }
    total += curEnd - curStart;
    [curStart, curEnd] = [start, end];
  }
  total += curEnd - curStart;

  return Math.round(total / MINUTE);
}

/**
 * One segment per completed attendance day.
 *
 * A day with no check-out yields nothing, on purpose. The person may still be
 * working, and a segment ending "now" would be a guess — one that TS-09 would
 * write into a timesheet as fact. Reporting nothing is recoverable; reporting
 * a number nobody worked is not.
 */
export function clockSegmentsFrom(rows: readonly RawAttendance[]): ClockSegment[] {
  const out: ClockSegment[] = [];

  for (const row of rows) {
    const start = toMs(row.checkIn);
    const end = toMs(row.checkOut);
    if (start === null || end === null || end <= start) continue;

    const breakMinutes = breakMinutesWithin(row.breaks, start, end);
    const grossMinutes = Math.round((end - start) / MINUTE);
    /** Breaks longer than the day itself would otherwise produce negative work. */
    const netMinutes = Math.max(0, grossMinutes - breakMinutes);

    out.push({
      date: row.date,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      breakMinutes,
      netMinutes,
      autoCheckedOut: row.autoCheckedOut === true,
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Hours to two decimals, the shape a timesheet entry wants. */
export function segmentHours(segment: ClockSegment): number {
  return Math.round((segment.netMinutes / 60) * 100) / 100;
}
