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
  autoCheckedOut: boolean;
}

const MINUTE = 60_000;

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

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

export function clockSegmentsFrom(rows: readonly RawAttendance[]): ClockSegment[] {
  const out: ClockSegment[] = [];

  for (const row of rows) {
    const start = toMs(row.checkIn);
    const end = toMs(row.checkOut);
    if (start === null || end === null || end <= start) continue;

    const breakMinutes = breakMinutesWithin(row.breaks, start, end);
    const grossMinutes = Math.round((end - start) / MINUTE);
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

export function segmentHours(segment: ClockSegment): number {
  return Math.round((segment.netMinutes / 60) * 100) / 100;
}
