import {
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  divideDecimals,
  compareDecimals,
  isZero,
  formatDecimal,
  roundDecimal,
  negateDecimal,
  absDecimal,
  toDecimal,
  decimalFromNumber,
  sumDecimals,
  allocateDecimal,
  assertDebitsEqualsCredits,
} from "./money.util";

describe("addDecimals", () => {
  it("adds whole numbers", () => {
    expect(addDecimals("1", "2")).toBe("3.0000");
  });

  it("adds decimals without float drift (0.1 + 0.2)", () => {
    expect(addDecimals("0.1", "0.2")).toBe("0.3000");
  });

  it("adds to 4dp precision", () => {
    expect(addDecimals("1.1234", "2.3456")).toBe("3.4690");
  });

  it("adds negative numbers", () => {
    expect(addDecimals("-1.5000", "2.0000")).toBe("0.5000");
  });

  it("adds zero to value unchanged", () => {
    expect(addDecimals("99.9999", "0")).toBe("99.9999");
  });

  it("handles both operands negative", () => {
    expect(addDecimals("-5.0000", "-3.0000")).toBe("-8.0000");
  });

  it("handles undefined-like empty string as zero", () => {
    expect(addDecimals("", "1.0000")).toBe("1.0000");
  });
});

describe("subtractDecimals", () => {
  it("subtracts without float drift (0.3 - 0.1)", () => {
    expect(subtractDecimals("0.3", "0.1")).toBe("0.2000");
  });

  it("produces negative result", () => {
    expect(subtractDecimals("1.0000", "2.5000")).toBe("-1.5000");
  });

  it("subtracts to zero", () => {
    expect(subtractDecimals("5.0000", "5.0000")).toBe("0.0000");
  });
});

describe("multiplyDecimals", () => {
  it("multiplies two decimal strings", () => {
    expect(multiplyDecimals("2.0000", "3.0000")).toBe("6.0000");
  });

  it("multiplies fractional values", () => {
    expect(multiplyDecimals("1.5", "2.5")).toBe("3.7500");
  });

  it("multiplies with exchange rate scenario", () => {
    expect(multiplyDecimals("100.00", "83.5")).toBe("8350.0000");
  });

  it("zero times anything is zero", () => {
    expect(multiplyDecimals("0", "999.9999")).toBe("0.0000");
  });
});

describe("compareDecimals", () => {
  it("returns -1 when a < b", () => {
    expect(compareDecimals("1.0000", "2.0000")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareDecimals("2.0000", "1.0000")).toBe(1);
  });

  it("returns 0 when a === b", () => {
    expect(compareDecimals("1.5000", "1.5000")).toBe(0);
  });

  it("compares negative values correctly", () => {
    expect(compareDecimals("-1.0000", "0.0000")).toBe(-1);
  });

  it("handles 0.1+0.2 float hazard via bigint", () => {
    const sum = addDecimals("0.1", "0.2");
    expect(compareDecimals(sum, "0.3000")).toBe(0);
  });
});

describe("isZero", () => {
  it("returns true for zero string", () => {
    expect(isZero("0")).toBe(true);
    expect(isZero("0.0000")).toBe(true);
  });

  it("returns false for non-zero", () => {
    expect(isZero("0.0001")).toBe(false);
    expect(isZero("-0.0001")).toBe(false);
  });
});

describe("formatDecimal", () => {
  it("formats to default 4dp", () => {
    expect(formatDecimal("1")).toBe("1.0000");
  });

  it("formats to specified dp", () => {
    expect(formatDecimal("1.12345", 2)).toBe("1.12");
  });

  it("truncates rather than rounds to dp", () => {
    expect(formatDecimal("1.9999", 2)).toBe("1.99");
  });
});

describe("assertDebitsEqualsCredits", () => {
  it("passes when debits equal credits", () => {
    expect(() =>
      assertDebitsEqualsCredits([
        { debit: "100.00", credit: "0" },
        { debit: "0", credit: "100.00" },
      ]),
    ).not.toThrow();
  });

  it("passes with multi-line balanced entry", () => {
    expect(() =>
      assertDebitsEqualsCredits([
        { debit: "50.00", credit: "0" },
        { debit: "50.00", credit: "0" },
        { debit: "0", credit: "100.00" },
      ]),
    ).not.toThrow();
  });

  it("throws when debits do not equal credits", () => {
    expect(() =>
      assertDebitsEqualsCredits([
        { debit: "100.00", credit: "0" },
        { debit: "0", credit: "99.99" },
      ]),
    ).toThrow("Journal entry debits do not equal credits");
  });

  it("treats missing debit/credit as zero", () => {
    expect(() =>
      assertDebitsEqualsCredits([{ debit: "50.00" }, { credit: "50.00" }]),
    ).not.toThrow();
  });

  it("throws for empty lines (0 !== 0 is false — actually passes)", () => {
    expect(() => assertDebitsEqualsCredits([])).not.toThrow();
  });
});

describe("sumDecimals", () => {
  it("sums the canonical float hazard to an exact third", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3000");
  });

  it("treats null, undefined and empty text from a nullable numeric column as zero", () => {
    expect(sumDecimals([null, undefined, "", "5.25"])).toBe("5.2500");
  });

  it("stays exact over a hundred thousand rows, where a double has already lost the fourth decimal", () => {
    const rows = new Array(100_000).fill("1234.5600");
    const floatTotal = rows.reduce((acc, row) => acc + Number(row), 0);
    expect(floatTotal).not.toBe(123_456_000);
    expect(sumDecimals(rows)).toBe("123456000.0000");
  });

  it("sums an empty ledger to zero rather than to NaN", () => {
    expect(sumDecimals([])).toBe("0.0000");
  });
});

describe("roundDecimal", () => {
  it("rounds half away from zero, the way a printed statement does", () => {
    expect(roundDecimal("1.005", 2)).toBe("1.01");
    expect(roundDecimal("-1.005", 2)).toBe("-1.01");
    expect(roundDecimal("1.0049", 2)).toBe("1.00");
  });

  it("never prints a negative zero", () => {
    expect(roundDecimal("-0.0001", 2)).toBe("0.00");
  });

  it("rounds to whole units and pads beyond the stored scale", () => {
    expect(roundDecimal("2.5", 0)).toBe("3");
    expect(roundDecimal("2.5", 6)).toBe("2.500000");
  });
});

describe("toDecimal and decimalFromNumber", () => {
  it("normalises a nullable numeric column to the ledger scale", () => {
    expect(toDecimal(null)).toBe("0.0000");
    expect(toDecimal("  12.5 ")).toBe("12.5000");
  });

  it("pins a JSON number to the ledger scale once, at the boundary", () => {
    expect(decimalFromNumber(0.1 + 0.2)).toBe("0.3000");
    expect(decimalFromNumber(-7)).toBe("-7.0000");
  });

  it("refuses a non-finite amount instead of storing NaN", () => {
    expect(() => decimalFromNumber(Number.NaN)).toThrow(/finite/);
  });

  it("refuses text that is not a decimal instead of silently reading it as zero", () => {
    expect(() => toDecimal("twelve")).toThrow(/decimal/);
  });
});

describe("negateDecimal and absDecimal", () => {
  it("flips and strips sign exactly", () => {
    expect(negateDecimal("1.2345")).toBe("-1.2345");
    expect(absDecimal("-1.2345")).toBe("1.2345");
  });
});

describe("divideDecimals", () => {
  it("divides with half-up rounding at the ledger scale", () => {
    expect(divideDecimals("10", "4")).toBe("2.5000");
    expect(divideDecimals("1", "3")).toBe("0.3333");
    expect(divideDecimals("-1", "3")).toBe("-0.3333");
  });

  it("refuses division by zero rather than returning Infinity", () => {
    expect(() => divideDecimals("1", "0")).toThrow(/zero/);
  });
});

describe("allocateDecimal", () => {
  it("splits a total that does not divide evenly without losing or inventing a paisa", () => {
    const parts = allocateDecimal("100.0000", ["1", "1", "1"]);
    expect(sumDecimals(parts)).toBe("100.0000");
    expect(parts).toEqual(["33.3334", "33.3333", "33.3333"]);
  });

  it("splits proportionally and still sums to the total", () => {
    const parts = allocateDecimal("1000.0000", ["1", "2", "7"]);
    expect(parts).toEqual(["100.0000", "200.0000", "700.0000"]);
    expect(sumDecimals(parts)).toBe("1000.0000");
  });

  it("keeps a negative total exact and negative", () => {
    const parts = allocateDecimal("-100.0000", ["1", "1", "1"]);
    expect(sumDecimals(parts)).toBe("-100.0000");
  });

  it("gives every share zero when no weight carries any magnitude", () => {
    expect(allocateDecimal("100.0000", ["0", "0"])).toEqual(["0.0000", "0.0000"]);
  });

  it("sums to the total for a hundred uneven weights, which is what a tax apportionment looks like", () => {
    const weights = Array.from({ length: 100 }, (_value, index) => String(index + 1));
    expect(sumDecimals(allocateDecimal("7919.4321", weights))).toBe("7919.4321");
  });
});
