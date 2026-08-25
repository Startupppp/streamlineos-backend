import {
  add,
  allocate,
  applyBasisPoints,
  compare,
  convert,
  divideRoundHalfUp,
  extractInclusiveTax,
  fromDecimalString,
  minorUnitsOf,
  money,
  MoneyError,
  subtract,
  sum,
  toDecimalString,
} from "./money";

describe("money construction", () => {
  it("refuses a fractional minor unit", () => {
    expect(() => money(10.5, "INR")).toThrow(MoneyError);
  });

  it("refuses an amount past the safe integer range", () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, "INR")).toThrow(MoneyError);
  });

  it("refuses a non ISO-4217 code", () => {
    expect(() => money(100, "rupees")).toThrow(MoneyError);
    expect(() => money(100, "IN")).toThrow(MoneyError);
  });

  it("knows the scale of zero-, two- and three-decimal currencies", () => {
    expect(minorUnitsOf("JPY")).toBe(0);
    expect(minorUnitsOf("INR")).toBe(2);
    expect(minorUnitsOf("KWD")).toBe(3);
  });

  it("refuses arithmetic across currencies", () => {
    expect(() => add(money(100, "INR"), money(100, "USD"))).toThrow(MoneyError);
  });
});

describe("rounding", () => {
  it("rounds half away from zero in both directions", () => {
    expect(divideRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divideRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divideRoundHalfUp(15n, 10n)).toBe(2n);
    expect(divideRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divideRoundHalfUp(-15n, 10n)).toBe(-2n);
  });

  it("applies a basis-point rate", () => {
    // 18% of 100.00 INR
    expect(applyBasisPoints(money(10_000, "INR"), 1800)).toEqual(money(1800, "INR"));
    // 2.5% intra-state half of a 5% slab, on 999.99
    expect(applyBasisPoints(money(99_999, "INR"), 250)).toEqual(money(2500, "INR"));
  });

  it("extracts tax from a gross amount", () => {
    // 118.00 gross at 18% -> 18.00 tax, 100.00 net
    const gross = money(11_800, "INR");
    const tax = extractInclusiveTax(gross, 1800);
    expect(tax).toEqual(money(1800, "INR"));
    expect(subtract(gross, tax)).toEqual(money(10_000, "INR"));
  });
});

describe("FX conversion", () => {
  it("converts the PRD 11 worked example: $100.00 at 83.25 is Rs 8325.00", () => {
    expect(convert(money(10_000, "USD"), "INR", "83.25")).toEqual(money(832_500, "INR"));
  });

  it("is identity for the same currency at rate 1", () => {
    expect(convert(money(12_345, "INR"), "INR", "1")).toEqual(money(12_345, "INR"));
  });

  it("refuses a same-currency conversion at any rate but 1", () => {
    expect(() => convert(money(100, "INR"), "INR", "1.05")).toThrow(MoneyError);
  });

  it("crosses a zero-decimal currency into a two-decimal one", () => {
    // JPY 1000 (scale 0) at 0.55 INR per yen -> Rs 550.00 = 55000 paise
    expect(convert(money(1000, "JPY"), "INR", "0.55")).toEqual(money(55_000, "INR"));
  });

  it("crosses a two-decimal currency into a zero-decimal one", () => {
    // Rs 550.00 at 1.8181818182 JPY per rupee -> 1000 yen
    expect(convert(money(55_000, "INR"), "JPY", "1.8181818182")).toEqual(money(1000, "JPY"));
  });

  it("handles a three-decimal currency", () => {
    // KWD 1.000 at 271.50 INR -> Rs 271.50
    expect(convert(money(1000, "KWD"), "INR", "271.50")).toEqual(money(27_150, "INR"));
  });

  it("keeps full precision on a ten-decimal rate", () => {
    expect(convert(money(1_000_000, "USD"), "INR", "83.1234567891")).toEqual(
      money(83_123_457, "INR"),
    );
  });

  it("rejects a zero, negative or malformed rate", () => {
    expect(() => convert(money(100, "USD"), "INR", "0")).toThrow(MoneyError);
    expect(() => convert(money(100, "USD"), "INR", "-1")).toThrow(MoneyError);
    expect(() => convert(money(100, "USD"), "INR", "abc")).toThrow(MoneyError);
  });

  it("rejects a rate carrying more precision than the column holds", () => {
    expect(() => convert(money(100, "USD"), "INR", "83.12345678911")).toThrow(MoneyError);
  });
});

describe("allocation", () => {
  it("splits without losing a minor unit", () => {
    const parts = allocate(money(10_000, "INR"), [1, 1, 1]);
    expect(parts.map((p) => p.minor)).toEqual([3334, 3333, 3333]);
    expect(sum(parts, "INR")).toEqual(money(10_000, "INR"));
  });

  it("weights proportionally", () => {
    const parts = allocate(money(1000, "INR"), [3, 1]);
    expect(parts.map((p) => p.minor)).toEqual([750, 250]);
  });

  it("gives leftover units to the largest remainders first", () => {
    const parts = allocate(money(100, "INR"), [1, 1, 1, 1, 1, 1, 1]);
    expect(sum(parts, "INR")).toEqual(money(100, "INR"));
    expect(Math.max(...parts.map((p) => p.minor)) - Math.min(...parts.map((p) => p.minor))).toBe(1);
  });

  it("still ties when the amount is negative", () => {
    const parts = allocate(money(-10_000, "INR"), [1, 1, 1]);
    expect(sum(parts, "INR")).toEqual(money(-10_000, "INR"));
  });

  it("puts everything on the first slot when all weights are zero", () => {
    const parts = allocate(money(500, "INR"), [0, 0]);
    expect(parts.map((p) => p.minor)).toEqual([500, 0]);
    expect(sum(parts, "INR")).toEqual(money(500, "INR"));
  });
});

describe("formatting", () => {
  it("round-trips a decimal string", () => {
    expect(toDecimalString(money(832_500, "INR"))).toBe("8325.00");
    expect(toDecimalString(money(5, "INR"))).toBe("0.05");
    expect(toDecimalString(money(-1250, "USD"))).toBe("-12.50");
    expect(toDecimalString(money(1000, "JPY"))).toBe("1000");
    expect(toDecimalString(money(1234, "KWD"))).toBe("1.234");
  });

  it("parses a decimal string into minor units", () => {
    expect(fromDecimalString("8325.00", "INR")).toEqual(money(832_500, "INR"));
    expect(fromDecimalString("0.05", "INR")).toEqual(money(5, "INR"));
    expect(fromDecimalString("-12.5", "USD")).toEqual(money(-1250, "USD"));
    expect(fromDecimalString("1000", "JPY")).toEqual(money(1000, "JPY"));
  });

  it("refuses precision the currency cannot hold", () => {
    expect(() => fromDecimalString("10.005", "INR")).toThrow(MoneyError);
    expect(() => fromDecimalString("10.5", "JPY")).toThrow(MoneyError);
  });

  it("orders amounts", () => {
    expect(compare(money(100, "INR"), money(200, "INR"))).toBe(-1);
    expect(compare(money(200, "INR"), money(100, "INR"))).toBe(1);
    expect(compare(money(100, "INR"), money(100, "INR"))).toBe(0);
  });
});
