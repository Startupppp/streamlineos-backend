import { fromZonedTime, toZonedTime } from "date-fns-tz";

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const slash = part.indexOf("/");
      const rangePart = part.slice(0, slash);
      const step = Number(part.slice(slash + 1));
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid step in "${part}"`);
      let rangeStart = min;
      let rangeEnd = max;
      if (rangePart !== "*") {
        if (rangePart.includes("-")) {
          const dash = rangePart.indexOf("-");
          rangeStart = Number(rangePart.slice(0, dash));
          rangeEnd = Number(rangePart.slice(dash + 1));
        } else {
          rangeStart = Number(rangePart);
          rangeEnd = max;
        }
      }
      for (let i = rangeStart; i <= rangeEnd; i += step) values.add(i);
    } else if (part.includes("-")) {
      const dash = part.indexOf("-");
      const start = Number(part.slice(0, dash));
      const end = Number(part.slice(dash + 1));
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const n = Number(part);
      if (!Number.isFinite(n)) throw new Error(`Invalid cron field value "${part}"`);
      values.add(n);
    }
  }
  return values;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    return {
      minutes: parseCronField(parts[0] ?? "", 0, 59),
      hours: parseCronField(parts[1] ?? "", 0, 23),
      doms: parseCronField(parts[2] ?? "", 1, 31),
      months: parseCronField(parts[3] ?? "", 1, 12),
      dows: parseCronField(parts[4] ?? "", 0, 6),
      domStar: parts[2] === "*",
      dowStar: parts[4] === "*",
    };
  } catch {
    return null;
  }
}

const MAX_ITERATIONS = 2_102_400;

/**
 * Returns the next UTC Date that satisfies the cron expression after `after`, evaluated in
 * `timezone`. Returns null when the expression is invalid or no occurrence exists within 4 years.
 *
 * Missed-window policy: always advance from `after`, never from a prior `nextRunAt`. If the worker
 * was down for N intervals, the first tick after recovery fires once and skips the backlog.
 */
export function computeNextCronDate(
  expr: string,
  timezone: string,
  after: Date,
): Date | null {
  const parsed = parseCron(expr);
  if (!parsed || parsed.minutes.size === 0 || parsed.hours.size === 0) return null;

  const zoned = toZonedTime(after, timezone);
  const candidate = new Date(zoned);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const month = candidate.getMonth() + 1;
    const dom = candidate.getDate();
    const dow = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    if (!parsed.months.has(month)) {
      candidate.setDate(1);
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = parsed.doms.has(dom);
    const dowMatch = parsed.dows.has(dow);
    let dayMatches: boolean;
    if (!parsed.domStar && !parsed.dowStar) {
      dayMatches = domMatch || dowMatch;
    } else if (!parsed.domStar) {
      dayMatches = domMatch;
    } else if (!parsed.dowStar) {
      dayMatches = dowMatch;
    } else {
      dayMatches = true;
    }

    if (!dayMatches) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!parsed.hours.has(hour)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!parsed.minutes.has(minute)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    return fromZonedTime(candidate, timezone);
  }

  return null;
}
