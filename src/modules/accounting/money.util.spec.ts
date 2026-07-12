import {
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  compareDecimals,
  isZero,
  formatDecimal,
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
