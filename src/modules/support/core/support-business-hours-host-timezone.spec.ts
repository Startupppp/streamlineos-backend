import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addWorkingMinutes, type BusinessHoursConfig } from "./support-business-hours.util";

/**
 * The policy zone is Asia/Kolkata, which has no DST of its own, so anything that
 * moves came from the HOST. The window is 02:00-06:00 because 02:00-02:59 is the
 * hour that does not exist on a spring-forward day, and the three dates below are
 * the spring-forward days of the three zones CI's non-UTC matrix runs at: this
 * spec bites on every leg of it and on none of the UTC ones.
 */
function overnightPolicy(): BusinessHoursConfig {
  const day = { start: "02:00", end: "06:00" };
  return {
    timezone: "Asia/Kolkata",
    weeklySchedule: { sun: day, mon: day, tue: day, wed: day, thu: day, fri: day, sat: day },
    holidays: [],
    is24x7: false,
  };
}

const HOST_SPRING_FORWARD_CASES = [
  { host: "America/New_York", from: "2024-03-09T18:00:00.000Z", due: "2024-03-09T21:00:00.000Z" },
  { host: "Pacific/Auckland", from: "2024-09-28T12:00:00.000Z", due: "2024-09-28T21:00:00.000Z" },
  { host: "Australia/Adelaide", from: "2024-10-05T14:00:00.000Z", due: "2024-10-05T21:00:00.000Z" },
] as const;

describe("addWorkingMinutes does not track the host's clock", () => {
  it("opens the window at 02:00 in the policy's zone on every host's spring-forward day", () => {
    for (const { from, due } of HOST_SPRING_FORWARD_CASES) {
      const result = addWorkingMinutes(new Date(from), 30, overnightPolicy());

      expect(result.toISOString()).toBe(due);
    }
  });

  it("and closes it at 06:00, so a request that needs the whole window lands the same way", () => {
    const { from } = HOST_SPRING_FORWARD_CASES[0];
    const result = addWorkingMinutes(new Date(from), 240, overnightPolicy());

    expect(result.toISOString()).toBe("2024-03-10T00:30:00.000Z");
  });

  it("BITE: the day and window arithmetic reads and writes UTC fields only", () => {
    const source = readFileSync(join(__dirname, "support-business-hours.util.ts"), "utf-8");
    const body = source.slice(source.indexOf("export function addWorkingMinutes"));

    expect(source).not.toContain("date-fns-tz");
    expect(source).toContain("zoned-wall-clock");
    expect(body).not.toMatch(/\.(?:get|set)(?!UTC)(?:Hours|Minutes|Date|Day|Month|FullYear)\b/);
  });

  it("still answers an ordinary weekday window the same way it always did", () => {
    const nineToFive: BusinessHoursConfig = {
      timezone: "UTC",
      weeklySchedule: {
        mon: { start: "09:00", end: "17:00" },
        tue: { start: "09:00", end: "17:00" },
        wed: { start: "09:00", end: "17:00" },
        thu: { start: "09:00", end: "17:00" },
        fri: { start: "09:00", end: "17:00" },
      },
      holidays: [],
      is24x7: false,
    };

    expect(addWorkingMinutes(new Date("2026-03-06T16:30:00.000Z"), 60, nineToFive).toISOString()).toBe(
      "2026-03-09T09:30:00.000Z",
    );
  });
});
