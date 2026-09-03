import { formatDateOnly } from "./date.utils";

/**
 * A `YYYY-MM-DD` on the wire is a CALENDAR DATE — no time, no zone. `new Date()`
 * parses it as midnight UTC, and `getFullYear()/getMonth()/getDate()` then read
 * that instant in the HOST's zone, so the day moves on any host west of UTC.
 *
 * The host offset is an explicit parameter below rather than the runner's ambient
 * zone, so the defect reproduces under every host zone — at offset 0 the broken
 * mechanism agrees with the correct one, which is exactly why a UTC-only CI could
 * never fail on this.
 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function readInstantOnHost(value: string, hostOffsetMinutes: number): string {
  const shifted = new Date(new Date(value).getTime() + hostOffsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const CALENDAR_DATES = ["2026-03-01", "2026-01-01", "2026-12-31", "2024-02-29"] as const;

const HOSTS_WEST_OF_UTC = [-60, -180, -300, -480, -690] as const;
const HOSTS_EAST_OF_UTC = [60, 330, 570, 780] as const;

describe("formatDateOnly keeps a calendar date on its own day", () => {
  it("returns the day the caller was given, on any host", () => {
    for (const value of CALENDAR_DATES) expect(formatDateOnly(value)).toBe(value);
  });

  it("BITE: parsing it into an instant first moves the day on every host west of UTC", () => {
    for (const offset of HOSTS_WEST_OF_UTC) {
      expect(readInstantOnHost("2026-03-01", offset)).toBe("2026-02-28");
      expect(readInstantOnHost("2026-01-01", offset)).toBe("2025-12-31");
    }
  });

  it("BITE: and leaves it alone east of UTC, which is why the defect hides on half the planet", () => {
    for (const offset of HOSTS_EAST_OF_UTC) {
      expect(readInstantOnHost("2026-03-01", offset)).toBe("2026-03-01");
    }
  });

  it("still reads a real instant in the host's own zone, which is a different question", () => {
    const instant = "2026-03-01T04:30:00.000Z";
    const hostOffsetMinutes = -new Date(instant).getTimezoneOffset();

    expect(formatDateOnly(instant)).toBe(readInstantOnHost(instant, hostOffsetMinutes));
  });

  it("returns empty rather than Invalid-Date text for absent input", () => {
    expect(formatDateOnly(null)).toBe("");
    expect(formatDateOnly(undefined)).toBe("");
    expect(formatDateOnly("")).toBe("");
  });
});
