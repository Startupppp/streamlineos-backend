import { wholeDaysBetween } from "./period.helpers";

/**
 * The backdate limit, across timezones, because it used to depend on one.
 *
 * `backdateLimitDays: 3` should mean the same thing everywhere. It did not.
 * The check compared `new Date(today)` — parsed as UTC midnight — against
 * `new Date(input.date + "T12:00:00")` — parsed as LOCAL noon. That mixture
 * puts a half-day cushion into the subtraction whose size is the server's UTC
 * offset, and `Math.floor` then rounds it away. Measured on the old code:
 *
 *   UTC and Asia/Kolkata : 4 days back scored 3, so a limit of 3 ALLOWED it
 *   Pacific/Kiritimati   : 4 days back scored 4, so a limit of 3 REJECTED it
 *
 * Same setting, same data, different answer per machine — and in most zones
 * the limit silently permitted one extra day.
 *
 * These cases pin both properties: the boundary is exact, and it does not move
 * when the host does. The suite deliberately sweeps zones on either side of
 * UTC and past the date line rather than trusting the runner's own.
 */

const ZONES = ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Midway", "America/New_York"];

const TODAY = "2026-09-09";

/** `back` days before TODAY, as a plain date string. */
const daysBack = (back: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

describe("backdate limit arithmetic", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  for (const zone of ZONES) {
    describe(`in ${zone}`, () => {
      beforeEach(() => {
        process.env.TZ = zone;
      });

      it("counts a day as a day", () => {
        expect(wholeDaysBetween(daysBack(1), TODAY)).toBe(1);
        expect(wholeDaysBetween(daysBack(3), TODAY)).toBe(3);
        expect(wholeDaysBetween(daysBack(4), TODAY)).toBe(4);
      });

      /** The exact boundary a limit of 3 must draw: 3 in, 4 out. */
      it("admits exactly the limit and rejects one past it", () => {
        const limit = 3;
        expect(wholeDaysBetween(daysBack(3), TODAY) > limit).toBe(false);
        expect(wholeDaysBetween(daysBack(4), TODAY) > limit).toBe(true);
      });

      it("is symmetric and zero on the same day", () => {
        expect(wholeDaysBetween(TODAY, TODAY)).toBe(0);
        expect(wholeDaysBetween(TODAY, daysBack(2))).toBe(-2);
      });

      /** Month ends, DST changes and leap days are all just days. */
      it("crosses month, DST and leap boundaries without drifting", () => {
        expect(wholeDaysBetween("2026-02-27", "2026-03-02")).toBe(3);
        expect(wholeDaysBetween("2026-03-07", "2026-03-09")).toBe(2);
        expect(wholeDaysBetween("2026-10-31", "2026-11-02")).toBe(2);
        expect(wholeDaysBetween("2028-02-28", "2028-03-01")).toBe(2);
      });
    });
  }

  /**
   * The regression itself, stated as an executable comparison rather than a
   * comment: the old expression against the new one, at the day that used to
   * slip through.
   */
  it("no longer agrees with the old mixed-parse expression where that was wrong", () => {
    process.env.TZ = "Asia/Kolkata";
    const fourDaysBack = daysBack(4);
    const legacy = Math.floor(
      (new Date(TODAY).getTime() - new Date(`${fourDaysBack}T12:00:00`).getTime()) / 86_400_000,
    );

    expect(legacy).toBe(3);
    expect(wholeDaysBetween(fourDaysBack, TODAY)).toBe(4);
  });
});
