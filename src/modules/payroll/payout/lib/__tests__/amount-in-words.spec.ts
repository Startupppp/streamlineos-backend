import { amountInWords } from "../amount-in-words";

describe("amountInWords — Indian rupee numbering", () => {
  it("zero gives 'Zero Rupees Only' for INR", () => {
    expect(amountInWords("0.00", "INR")).toBe("Zero Rupees Only");
  });

  it("zero gives 'Zero Dollars Only' for USD", () => {
    expect(amountInWords("0.00", "USD")).toBe("Zero Dollars Only");
  });

  it("single digit", () => {
    expect(amountInWords("5.00", "INR")).toBe("Five Rupees Only");
  });

  it("two-digit number", () => {
    expect(amountInWords("42.00", "INR")).toBe("Forty Two Rupees Only");
  });

  it("hundred", () => {
    expect(amountInWords("100.00", "INR")).toBe("One Hundred Rupees Only");
  });

  it("three-digit number", () => {
    expect(amountInWords("250.00", "INR")).toBe("Two Hundred Fifty Rupees Only");
  });

  it("one thousand", () => {
    expect(amountInWords("1000.00", "INR")).toBe("One Thousand Rupees Only");
  });

  it("ten thousand", () => {
    expect(amountInWords("10000.00", "INR")).toBe("Ten Thousand Rupees Only");
  });

  it("one lakh (100000)", () => {
    expect(amountInWords("100000.00", "INR")).toBe("One Lakh Rupees Only");
  });

  it("Indian standard amount 1,23,456 → One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees Only", () => {
    expect(amountInWords("123456.00", "INR")).toBe("One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees Only");
  });

  it("ten lakh (1000000)", () => {
    expect(amountInWords("1000000.00", "INR")).toBe("Ten Lakh Rupees Only");
  });

  it("one crore (10000000)", () => {
    expect(amountInWords("10000000.00", "INR")).toBe("One Crore Rupees Only");
  });

  it("typical annual CTC 1200000 (12 lakh)", () => {
    expect(amountInWords("1200000.00", "INR")).toBe("Twelve Lakh Rupees Only");
  });

  it("truncates paise — only whole rupee converted (1,23,456.78 → integer part only)", () => {
    const result = amountInWords("123456.78", "INR");
    expect(result).toContain("Rupees Only");
    expect(result).not.toContain("Paise");
  });

  it("negative value treated as zero (fallback to 0)", () => {
    expect(amountInWords("-500.00", "INR")).toBe("Zero Rupees Only");
  });

  it("non-numeric string treated as zero", () => {
    expect(amountInWords("not-a-number", "INR")).toBe("Zero Rupees Only");
  });

  it("USD currency says Dollars not Rupees", () => {
    const result = amountInWords("5000.00", "USD");
    expect(result).toBe("Five Thousand Dollars Only");
    expect(result).not.toContain("Rupees");
  });

  it("nineteen (edge case teens)", () => {
    expect(amountInWords("19.00", "INR")).toBe("Nineteen Rupees Only");
  });

  it("twenty (boundary between teens and tens)", () => {
    expect(amountInWords("20.00", "INR")).toBe("Twenty Rupees Only");
  });

  it("99 (maximum two-digit)", () => {
    expect(amountInWords("99.00", "INR")).toBe("Ninety Nine Rupees Only");
  });

  it("999 (maximum three-digit)", () => {
    expect(amountInWords("999.00", "INR")).toBe("Nine Hundred Ninety Nine Rupees Only");
  });

  it("large CTC 50,00,000 (50 lakh)", () => {
    expect(amountInWords("5000000.00", "INR")).toBe("Fifty Lakh Rupees Only");
  });
});

describe("amountInWords — USD (international grouping)", () => {
  it("zero USD", () => {
    expect(amountInWords("0.00", "USD")).toBe("Zero Dollars Only");
  });

  it("whole dollars — no cents in output", () => {
    expect(amountInWords("1000.00", "USD")).toBe("One Thousand Dollars Only");
  });

  it("dollars with cents", () => {
    expect(amountInWords("1234.56", "USD")).toBe("One Thousand Two Hundred Thirty Four Dollars and Fifty Six Cents Only");
  });

  it("cents only (fractional < 1 dollar)", () => {
    expect(amountInWords("0.99", "USD")).toBe("Zero Dollars and Ninety Nine Cents Only");
  });

  it("one million USD", () => {
    expect(amountInWords("1000000.00", "USD")).toBe("One Million Dollars Only");
  });

  it("one billion USD", () => {
    expect(amountInWords("1000000000.00", "USD")).toBe("One Billion Dollars Only");
  });

  it("mixed billion+million+thousand", () => {
    expect(amountInWords("2001001001.00", "USD")).toBe("Two Billion One Million One Thousand One Dollars Only");
  });
});

describe("amountInWords — GBP", () => {
  it("zero GBP", () => {
    expect(amountInWords("0.00", "GBP")).toBe("Zero Pounds Only");
  });

  it("whole pounds", () => {
    expect(amountInWords("500.00", "GBP")).toBe("Five Hundred Pounds Only");
  });

  it("pounds and pence", () => {
    expect(amountInWords("100.50", "GBP")).toBe("One Hundred Pounds and Fifty Pence Only");
  });
});

describe("amountInWords — EUR", () => {
  it("zero EUR", () => {
    expect(amountInWords("0.00", "EUR")).toBe("Zero Euros Only");
  });

  it("whole euros", () => {
    expect(amountInWords("250.00", "EUR")).toBe("Two Hundred Fifty Euros Only");
  });

  it("euros and cents", () => {
    expect(amountInWords("1500.75", "EUR")).toBe("One Thousand Five Hundred Euros and Seventy Five Cents Only");
  });
});

describe("amountInWords — AED", () => {
  it("zero AED", () => {
    expect(amountInWords("0.00", "AED")).toBe("Zero Dirhams Only");
  });

  it("dirhams and fils", () => {
    expect(amountInWords("999.25", "AED")).toBe("Nine Hundred Ninety Nine Dirhams and Twenty Five Fils Only");
  });
});

describe("amountInWords — SGD / AUD", () => {
  it("SGD zero", () => {
    expect(amountInWords("0.00", "SGD")).toBe("Zero Dollars Only");
  });

  it("SGD with cents", () => {
    expect(amountInWords("1200.50", "SGD")).toBe("One Thousand Two Hundred Dollars and Fifty Cents Only");
  });

  it("AUD with cents", () => {
    expect(amountInWords("800.99", "AUD")).toBe("Eight Hundred Dollars and Ninety Nine Cents Only");
  });
});

describe("amountInWords — JPY (zero-decimal currency)", () => {
  it("zero JPY", () => {
    expect(amountInWords("0", "JPY")).toBe("Zero Yen Only");
  });

  it("whole yen — no fractional part", () => {
    expect(amountInWords("50000", "JPY")).toBe("Fifty Thousand Yen Only");
  });

  it("JPY with decimal input uses floor", () => {
    expect(amountInWords("1000.99", "JPY")).toBe("One Thousand Yen Only");
  });
});

describe("amountInWords — unknown / fallback ISO code", () => {
  it("unknown currency uses ISO code as label", () => {
    expect(amountInWords("100.00", "XYZ")).toBe("One Hundred XYZ Only");
  });

  it("unknown currency zero", () => {
    expect(amountInWords("0.00", "MXN")).toBe("Zero MXN Only");
  });
});
