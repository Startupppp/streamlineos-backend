import { amountInWords } from "../amount-in-words";

describe("amountInWords — Indian rupee numbering", () => {
  it("zero gives 'Zero Rupees Only' for INR", () => {
    expect(amountInWords("0.00", "INR")).toBe("Zero Rupees Only");
  });

  it("zero gives 'Zero Only' for non-INR currency", () => {
    expect(amountInWords("0.00", "USD")).toBe("Zero Only");
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

  it("non-INR currency appends Only (not Rupees)", () => {
    const result = amountInWords("5000.00", "USD");
    expect(result).toBe("Five Thousand Only");
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
