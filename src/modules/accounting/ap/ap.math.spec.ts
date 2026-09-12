import { bucketFor, computeLineNetMinor, daysBetween, periodKeyOf } from "./ap.math";

describe("computeLineNetMinor", () => {
  it("multiplies thousandth quantities without touching a float", () => {
    // 2.5 hours at ₹1,000.00 is ₹2,500.00 exactly.
    expect(computeLineNetMinor(2500, 100_000, 0)).toBe(250_000);
  });

  it("rounds half up once, at the end", () => {
    // 0.333 × 100 paise = 33.3 paise -> 33.
    expect(computeLineNetMinor(333, 100, 0)).toBe(33);
    // 0.335 × 100 paise = 33.5 paise -> 34, not 33.
    expect(computeLineNetMinor(335, 100, 0)).toBe(34);
  });

  it("subtracts the discount after rounding the extension", () => {
    expect(computeLineNetMinor(1000, 10_000, 1_500)).toBe(8_500);
  });

  it("handles a whole-unit line", () => {
    expect(computeLineNetMinor(1000, 10_000, 0)).toBe(10_000);
  });
});

describe("periodKeyOf", () => {
  it("derives the return period from the document date", () => {
    expect(periodKeyOf("2026-08-25")).toBe("2026-08");
  });
});

describe("daysBetween", () => {
  it("counts whole days forwards and backwards", () => {
    expect(daysBetween("2026-08-01", "2026-08-31")).toBe(30);
    expect(daysBetween("2026-08-31", "2026-08-01")).toBe(-30);
    expect(daysBetween("2026-08-25", "2026-08-25")).toBe(0);
  });

  it("crosses a month and a year boundary", () => {
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("bucketFor", () => {
  it("puts not-yet-due and freshly overdue items in the current column", () => {
    expect(bucketFor(-10)).toBe("0-30");
    expect(bucketFor(0)).toBe("0-30");
    expect(bucketFor(30)).toBe("0-30");
  });

  it("steps at 31, 61 and 91 days", () => {
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(60)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("91+");
    expect(bucketFor(400)).toBe("91+");
  });
});
