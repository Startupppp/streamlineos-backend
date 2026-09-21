import {
  breakMinutesWithin,
  clockSegmentsFrom,
  segmentHours,
  type RawAttendance,
} from "../lib/clock-segments";

const day = (h: number, m = 0) => new Date(Date.UTC(2026, 4, 11, h, m)).toISOString();

const base: RawAttendance = {
  date: "2026-05-11",
  checkIn: day(9),
  checkOut: day(17),
  breaks: [],
};

describe("breakMinutesWithin", () => {
  const start = Date.parse(day(9));
  const end = Date.parse(day(17));

  it("is zero when there are no breaks", () => {
    expect(breakMinutesWithin([], start, end)).toBe(0);
    expect(breakMinutesWithin(null, start, end)).toBe(0);
    expect(breakMinutesWithin(undefined, start, end)).toBe(0);
  });

  it("sums ordinary separate breaks", () => {
    expect(
      breakMinutesWithin(
        [
          { start: day(11), end: day(11, 15) },
          { start: day(13), end: day(13, 45) },
        ],
        start,
        end,
      ),
    ).toBe(60);
  });

  it("merges overlapping breaks instead of double-counting", () => {
    expect(
      breakMinutesWithin(
        [
          { start: day(12), end: day(13) },
          { start: day(12, 30), end: day(13, 30) },
        ],
        start,
        end,
      ),
    ).toBe(90);
  });

  it("merges a break entirely inside another", () => {
    expect(
      breakMinutesWithin(
        [
          { start: day(12), end: day(14) },
          { start: day(12, 30), end: day(13) },
        ],
        start,
        end,
      ),
    ).toBe(120);
  });

  it("clamps a break to the working window", () => {
    expect(breakMinutesWithin([{ start: day(16, 30), end: day(19) }], start, end)).toBe(30);
    expect(breakMinutesWithin([{ start: day(7), end: day(9, 30) }], start, end)).toBe(30);
  });

  it("ignores a break entirely outside the window", () => {
    expect(breakMinutesWithin([{ start: day(18), end: day(19) }], start, end)).toBe(0);
  });

  it("treats an unended break as running to the check-out", () => {
    expect(breakMinutesWithin([{ start: day(16), end: undefined }], start, end)).toBe(60);
  });

  it("ignores a break whose timestamps do not parse", () => {
    expect(breakMinutesWithin([{ start: "not a time", end: day(12) }], start, end)).toBe(0);
  });
});

describe("clockSegmentsFrom", () => {
  it("derives net minutes as the window less the breaks", () => {
    const [segment] = clockSegmentsFrom([
      { ...base, breaks: [{ start: day(13), end: day(13, 30) }] },
    ]);

    expect(segment).toMatchObject({ date: "2026-05-11", breakMinutes: 30, netMinutes: 450 });
    expect(segmentHours(segment!)).toBe(7.5);
  });

  it("yields nothing for a day that has not been checked out", () => {
    expect(clockSegmentsFrom([{ ...base, checkOut: null }])).toEqual([]);
    expect(clockSegmentsFrom([{ ...base, checkIn: null }])).toEqual([]);
  });

  it("yields nothing when the clock ran backwards", () => {
    expect(clockSegmentsFrom([{ ...base, checkIn: day(17), checkOut: day(9) }])).toEqual([]);
  });

  it("never reports negative work when the breaks exceed the day", () => {
    const [segment] = clockSegmentsFrom([
      { ...base, checkOut: day(10), breaks: [{ start: day(9), end: day(17) }] },
    ]);

    expect(segment?.netMinutes).toBe(0);
  });

  it("marks a day the sweep closed, so a caller can treat the end as approximate", () => {
    const [auto] = clockSegmentsFrom([{ ...base, autoCheckedOut: true }]);
    const [manual] = clockSegmentsFrom([base]);

    expect(auto?.autoCheckedOut).toBe(true);
    expect(manual?.autoCheckedOut).toBe(false);
  });

  it("returns days in date order regardless of the order it received them", () => {
    const segments = clockSegmentsFrom([
      { ...base, date: "2026-05-13" },
      { ...base, date: "2026-05-11" },
      { ...base, date: "2026-05-12" },
    ]);

    expect(segments.map((s) => s.date)).toEqual(["2026-05-11", "2026-05-12", "2026-05-13"]);
  });

  it("accepts Date objects as well as ISO strings, which is what drizzle returns", () => {
    const [segment] = clockSegmentsFrom([
      { ...base, checkIn: new Date(day(9)), checkOut: new Date(day(12)) },
    ]);

    expect(segment?.netMinutes).toBe(180);
  });
});
