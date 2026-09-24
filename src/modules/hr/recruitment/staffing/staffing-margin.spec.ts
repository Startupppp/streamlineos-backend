import { fromPaise, marginFor, rollUpMargins, toPaise } from "./staffing-margin";

describe("toPaise / fromPaise", () => {
  it("round-trips a decimal(10,2) string exactly", () => {
    for (const value of ["0.00", "1.00", "33.37", "100.10", "9999999.99"]) {
      expect(fromPaise(toPaise(value) as number)).toBe(value);
    }
  });

  it("pads a single decimal place the way the column would", () => {
    expect(toPaise("12.5")).toBe(1250);
    expect(toPaise("12")).toBe(1200);
  });

  it("handles negatives on both sides", () => {
    expect(toPaise("-4.20")).toBe(-420);
    expect(fromPaise(-420)).toBe("-4.20");
    expect(fromPaise(-5)).toBe("-0.05");
  });

  /**
   * A third decimal place would mean the column changed under this function.
   * Truncating it silently would make the margin disagree with the invoice by a
   * rounding nobody chose, so it refuses instead.
   */
  it("refuses anything that is not the column's shape", () => {
    for (const bad of ["12.345", "abc", "", "1e3", "1,200.00", " ", "--1.00"]) {
      expect(toPaise(bad)).toBeNull();
    }
    expect(toPaise(null)).toBeNull();
    expect(toPaise(undefined)).toBeNull();
  });
});

describe("marginFor", () => {
  /**
   * The defect this module replaced. `Number("100.10") - Number("33.37")` is
   * 66.72999999999999 in binary floating point, and the old `.toFixed(2)`
   * rounded that error out of sight rather than out of existence.
   */
  it("is exact where floating point is not", () => {
    expect(Number("100.10") - Number("33.37")).not.toBe(66.73);
    expect(marginFor("100.10", "33.37").marginAmount).toBe("66.73");
  });

  it("stays exact across a hundred placements, where the float error accumulates", () => {
    const rows = Array.from({ length: 100 }, () => ({ billRate: "100.10", payRate: "33.37" }));
    expect(rollUpMargins(rows).totalMargin).toBe("6673.00");

    const floatTotal = rows.reduce((sum, r) => sum + (Number(r.billRate) - Number(r.payRate)), 0);
    expect(floatTotal).not.toBe(6673);
  });

  it("quotes the percentage of the bill rate, which is what a client reads", () => {
    expect(marginFor("100.00", "75.00").marginPercent).toBe(25);
    expect(marginFor("80.00", "60.00").marginPercent).toBe(25);
  });

  /**
   * Zero is a real margin — a placement made at cost — and a desk that cannot
   * tell it from "nobody has entered the rates yet" will chase the wrong
   * contracts.
   */
  it("returns nulls for a missing rate and zeros for a real zero", () => {
    expect(marginFor(null, "33.37")).toEqual({
      marginAmount: null,
      marginPercent: null,
      negative: false,
    });
    expect(marginFor("50.00", null).marginAmount).toBeNull();
    expect(marginFor("50.00", "50.00")).toEqual({
      marginAmount: "0.00",
      marginPercent: 0,
      negative: false,
    });
  });

  /**
   * A contractor placed above the bill rate is the most expensive thing that
   * can go unnoticed in this table, and it arrives through an ordinary
   * data-entry slip. Flagged rather than left as a minus sign to spot.
   */
  it("flags a placement made below cost", () => {
    const margin = marginFor("40.00", "55.00");
    expect(margin.negative).toBe(true);
    expect(margin.marginAmount).toBe("-15.00");
    expect(margin.marginPercent).toBe(-37.5);
  });

  it("has no percentage at all on a zero bill rate, rather than an infinity", () => {
    expect(marginFor("0.00", "10.00").marginPercent).toBeNull();
    expect(marginFor("0.00", "10.00").marginAmount).toBe("-10.00");
  });
});

describe("rollUpMargins", () => {
  const rows = [
    { billRate: "100.00", payRate: "70.00" },
    { billRate: "50.00", payRate: "55.00" },
    { billRate: null, payRate: "20.00" },
    { billRate: "80.00", payRate: null },
  ];

  /**
   * A blended margin computed over the rows that happen to carry rates, and
   * presented as the margin, is the number that makes an unprofitable desk look
   * fine. The count of unpriced rows sits beside the total so nobody can read
   * one without the other.
   */
  it("reports what it could not price instead of folding it in", () => {
    const rollup = rollUpMargins(rows);
    expect(rollup.priced).toBe(2);
    expect(rollup.unpriced).toBe(2);
    expect(rollup.totalMargin).toBe("25.00");
    expect(rollup.totalBill).toBe("150.00");
  });

  it("blends on the bill total, and counts the loss-making placements", () => {
    const rollup = rollUpMargins(rows);
    expect(rollup.blendedPercent).toBe(16.7);
    expect(rollup.negativeCount).toBe(1);
  });

  it("has no blended percentage when nothing is priced", () => {
    const rollup = rollUpMargins([{ billRate: null, payRate: null }]);
    expect(rollup.blendedPercent).toBeNull();
    expect(rollup.totalMargin).toBe("0.00");
    expect(rollup.priced).toBe(0);
  });

  it("is empty-safe", () => {
    expect(rollUpMargins([])).toEqual({
      priced: 0,
      unpriced: 0,
      totalMargin: "0.00",
      totalBill: "0.00",
      blendedPercent: null,
      negativeCount: 0,
    });
  });
});
