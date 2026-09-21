import { wholeDaysBetween } from "./period.helpers";

const ZONES = ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Midway", "America/New_York"];

const TODAY = "2026-09-09";

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

      it("admits exactly the limit and rejects one past it", () => {
        const limit = 3;
        expect(wholeDaysBetween(daysBack(3), TODAY) > limit).toBe(false);
        expect(wholeDaysBetween(daysBack(4), TODAY) > limit).toBe(true);
      });

      it("is symmetric and zero on the same day", () => {
        expect(wholeDaysBetween(TODAY, TODAY)).toBe(0);
        expect(wholeDaysBetween(TODAY, daysBack(2))).toBe(-2);
      });

      it("crosses month, DST and leap boundaries without drifting", () => {
        expect(wholeDaysBetween("2026-02-27", "2026-03-02")).toBe(3);
        expect(wholeDaysBetween("2026-03-07", "2026-03-09")).toBe(2);
        expect(wholeDaysBetween("2026-10-31", "2026-11-02")).toBe(2);
        expect(wholeDaysBetween("2028-02-28", "2028-03-01")).toBe(2);
      });
    });
  }

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
