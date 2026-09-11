import {
  MAX_DAY_OF_MONTH,
  isReportCadence,
  nextRunAt,
  type CadenceSpec,
} from "./report-schedule-cadence";

/**
 * CRM-P2-08. The three ways a schedule goes wrong are firing twice, skipping a
 * period, and drifting an hour every daylight-saving change. None of them show
 * up in a green integration test, so they are decided here.
 */

const spec = (over: Partial<CadenceSpec> = {}): CadenceSpec => ({
  cadence: "daily",
  hour: 8,
  dayOfWeek: 1,
  dayOfMonth: 1,
  ...over,
});

/** What the clock says in a zone, so an assertion reads as a person would. */
function local(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

describe("nextRunAt", () => {
  it("is strictly after the instant it is given", () => {
    /**
     * The property that stops a report firing twice. The sweep advances
     * `next_run_at` from the value it just consumed, so returning the same
     * instant would leave the row due on every tick until the clock passed it.
     */
    const due = new Date("2026-09-09T02:30:00.000Z");
    const next = nextRunAt(spec(), due, "Asia/Kolkata");
    expect(next.getTime()).toBeGreaterThan(due.getTime());
  });

  it("puts a daily report at the same local hour every day", () => {
    const first = nextRunAt(spec({ hour: 8 }), new Date("2026-09-09T00:00:00.000Z"), "Asia/Kolkata");
    const second = nextRunAt(spec({ hour: 8 }), first, "Asia/Kolkata");

    expect(local(first, "Asia/Kolkata")).toContain("08:00");
    expect(local(second, "Asia/Kolkata")).toContain("08:00");
    expect(second.getTime() - first.getTime()).toBe(24 * 3_600_000);
  });

  it("holds the local hour across a daylight-saving change", () => {
    /**
     * The bug this file exists for. Europe/London springs forward in the small
     * hours of Sunday 2026-03-29, so 08:00 on the Sunday is 23 hours after
     * 08:00 on the Saturday, not 24. Adding a fixed day in UTC would deliver at
     * 09:00 local for the next five months, which reads as the schedule quietly
     * breaking rather than as an error.
     */
    const before = new Date("2026-03-27T09:00:00.000Z");
    const next = nextRunAt(spec({ hour: 8 }), before, "Europe/London");
    const after = nextRunAt(spec({ hour: 8 }), next, "Europe/London");

    expect(local(next, "Europe/London")).toContain("08:00");
    expect(local(after, "Europe/London")).toContain("08:00");
    /** 23 hours in wall-clock terms, which is the whole point. */
    expect(after.getTime() - next.getTime()).toBe(23 * 3_600_000);
  });

  it("lands a weekly report on the named weekday", () => {
    const monday = nextRunAt(
      spec({ cadence: "weekly", dayOfWeek: 1, hour: 9 }),
      new Date("2026-09-09T00:00:00.000Z"),
      "Asia/Kolkata",
    );

    expect(local(monday, "Asia/Kolkata")).toContain("Mon");
    expect(local(monday, "Asia/Kolkata")).toContain("09:00");
  });

  it("advances a weekly report by exactly one week", () => {
    const zone = "Asia/Kolkata";
    const first = nextRunAt(
      spec({ cadence: "weekly", dayOfWeek: 4 }),
      new Date("2026-09-09T00:00:00.000Z"),
      zone,
    );
    const second = nextRunAt(spec({ cadence: "weekly", dayOfWeek: 4 }), first, zone);

    expect(second.getTime() - first.getTime()).toBe(7 * 24 * 3_600_000);
  });

  it("lands a monthly report on the named day, in every month", () => {
    const zone = "Asia/Kolkata";
    const monthly = spec({ cadence: "monthly", dayOfMonth: 28, hour: 7 });
    let cursor = new Date("2026-01-01T00:00:00.000Z");

    /** Through February, which is where a clamped day-of-month goes wrong. */
    for (let month = 0; month < 4; month += 1) {
      cursor = nextRunAt(monthly, cursor, zone);
      const shown = local(cursor, zone);
      expect(shown).toContain("28/");
      expect(shown).toContain("07:00");
    }
  });

  it("refuses nothing, but 28 is the highest day a schedule may name", () => {
    /**
     * The cap is enforced by the DTO rather than here — this pins the reason.
     * "The 31st" either skips February or silently becomes the 28th for one
     * month a year, and both are a report that did not arrive when somebody was
     * told it would.
     */
    expect(MAX_DAY_OF_MONTH).toBe(28);
  });

  it("falls back to UTC rather than throwing on a zone tzdata has dropped", () => {
    /**
     * A sweep iterates every organisation; one row carrying a retired zone must
     * not stop every other tenant's reports.
     */
    const next = nextRunAt(spec({ hour: 6 }), new Date("2026-09-09T00:00:00.000Z"), "Mars/Olympus_Mons");
    expect(local(next, "UTC")).toContain("06:00");
  });

  it("knows which cadence strings are real", () => {
    expect(isReportCadence("weekly")).toBe(true);
    expect(isReportCadence("hourly")).toBe(false);
  });
});
