import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromWallClockUtc } from "../../../common/date/zoned-wall-clock";
import { computeNextCronDate } from "./cron-next";

/**
 * Every schedule here is evaluated in Asia/Kolkata, which has no DST of its own.
 * Any movement therefore comes from the HOST, which is the whole point.
 *
 * The three days below are the spring-forward days of the three zones CI's
 * non-UTC matrix runs at, so this spec bites on every leg of it: at
 * America/New_York the first case fails, at Pacific/Auckland the second, at
 * Australia/Adelaide the third. At UTC none of them do — which is exactly why a
 * UTC-only runner could never have caught this.
 */
const ZONE = "Asia/Kolkata";

const HOST_SPRING_FORWARD_DAYS = [
  { host: "America/New_York", day: "2024-03-10" },
  { host: "Pacific/Auckland", day: "2024-09-29" },
  { host: "Australia/Adelaide", day: "2024-10-06" },
] as const;

function instantAt(day: string, hhmm: string): Date {
  return fromWallClockUtc(new Date(`${day}T${hhmm}:00.000Z`), ZONE);
}

function wallClockIn(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}`;
}

describe("computeNextCronDate does not track the host's clock", () => {
  it("fires a 02:30 daily schedule on each host's own spring-forward day", () => {
    for (const { day } of HOST_SPRING_FORWARD_DAYS) {
      const next = computeNextCronDate("30 2 * * *", ZONE, instantAt(day, "01:00"));

      expect(next).not.toBeNull();
      expect(wallClockIn(next as Date)).toBe(`${day} 02:30`);
    }
  });

  it("does not skip the whole hour either — 02:00 through 02:59 all still fire", () => {
    const { day } = HOST_SPRING_FORWARD_DAYS[0];

    for (const minute of [0, 1, 30, 59]) {
      const next = computeNextCronDate(`${minute} 2 * * *`, ZONE, instantAt(day, "01:00"));

      expect(wallClockIn(next as Date)).toBe(`${day} 02:${String(minute).padStart(2, "0")}`);
    }
  });

  it("BITE: the walk reads and writes UTC fields only", () => {
    const source = readFileSync(join(__dirname, "cron-next.ts"), "utf-8");
    const walk = source.slice(source.indexOf("export function computeNextCronDate"));

    expect(walk).toMatch(/toWallClockUtc\(after, timezone\)/);
    expect(walk).toMatch(/fromWallClockUtc\(candidate, timezone\)/);
    expect(walk).not.toMatch(/candidate\.(?:get|set)(?!UTC)[A-Z]/);
    expect(source).not.toContain("date-fns-tz");
  });

  it("still answers the ordinary questions the scheduler asks", () => {
    const monday = computeNextCronDate("0 9 * * 1", ZONE, instantAt("2024-03-06", "12:00"));
    expect(wallClockIn(monday as Date)).toBe("2024-03-11 09:00");

    const firstOfMonth = computeNextCronDate("0 0 1 * *", ZONE, instantAt("2024-03-15", "12:00"));
    expect(wallClockIn(firstOfMonth as Date)).toBe("2024-04-01 00:00");

    const everyQuarterHour = computeNextCronDate("*/15 * * * *", ZONE, instantAt("2024-03-10", "01:02"));
    expect(wallClockIn(everyQuarterHour as Date)).toBe("2024-03-10 01:15");

    const leapDay = computeNextCronDate("0 0 29 2 *", ZONE, instantAt("2024-01-01", "00:00"));
    expect(wallClockIn(leapDay as Date)).toBe("2024-02-29 00:00");
  });

  it("returns null rather than guessing at an expression it cannot parse", () => {
    expect(computeNextCronDate("not a cron", ZONE, new Date())).toBeNull();
    expect(computeNextCronDate("0 9 * *", ZONE, new Date())).toBeNull();
  });
});
