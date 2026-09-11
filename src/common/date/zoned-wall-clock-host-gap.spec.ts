import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatZoneClockTime, toWallClockUtc } from "./zoned-wall-clock";

/**
 * Each instant below reads as 02:10 in Asia/Kolkata — a zone with no DST — and
 * that 02:10 is the hour that does not exist on the HOST's own spring-forward
 * day, for the three zones CI's non-UTC matrix runs at. `date-fns-tz`'s
 * `toZonedTime` normalises the missing hour forward, so it and everything built
 * on it (`formatInTimeZone` included) answer 03:10 there. This spec therefore
 * bites on every non-UTC leg and on none of the UTC ones.
 */
const HOST_GAP_INSTANTS = [
  { host: "America/New_York", instant: "2024-03-09T20:40:00.000Z" },
  { host: "Pacific/Auckland", instant: "2024-09-28T20:40:00.000Z" },
  { host: "Australia/Adelaide", instant: "2024-10-05T20:40:00.000Z" },
] as const;

const ZONE = "Asia/Kolkata";

function zoneReading(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

describe("the wall-clock conversion survives the host's own missing hour", () => {
  it("reads 02:10 in the event's zone even when the host has no 02:10 that day", () => {
    for (const { instant } of HOST_GAP_INSTANTS) {
      const wall = toWallClockUtc(new Date(instant), ZONE);

      expect(`${wall.getUTCHours()}:${wall.getUTCMinutes()}`).toBe("2:10");
      expect(zoneReading(new Date(instant))).toBe("02:10");
    }
  });

  it("formats it as 2:10 AM rather than an hour late", () => {
    for (const { instant } of HOST_GAP_INSTANTS)
      expect(formatZoneClockTime(new Date(instant), ZONE)).toBe("2:10 AM");
  });

  it("keeps the 12-hour boundaries date-fns's `p` uses", () => {
    const at = (iso: string) => formatZoneClockTime(new Date(iso), ZONE);

    expect(at("2024-07-01T00:05:00.000Z")).toBe("5:35 AM");
    expect(at("2024-07-01T06:30:00.000Z")).toBe("12:00 PM");
    expect(at("2024-01-01T18:29:00.000Z")).toBe("11:59 PM");
    expect(at("2024-01-01T18:30:00.000Z")).toBe("12:00 AM");
  });

  it("BITE: the attendance verdict reads UTC fields of the wall clock, not the host's", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "modules", "hr", "time", "attendance-summary.service.ts"),
      "utf-8",
    );

    expect(source).not.toContain("date-fns-tz");
    expect(source).toContain("toWallClockUtc(new Date(row.checkIn), orgTimezone)");
    expect(source).toContain("localCi.getUTCHours() * 60 + localCi.getUTCMinutes()");
    expect(source).toContain("localCo.getUTCHours() * 60 + localCo.getUTCMinutes()");
  });
});
