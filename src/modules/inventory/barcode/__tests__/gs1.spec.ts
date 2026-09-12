import { parseGs1, parseGs1Date } from "../gs1";

/** FNC1 as transmitted by a wedge. */
const GS = "\x1D";

describe("INV-203 GS1 element string parsing", () => {
  it("reads a GTIN that runs straight into the next element", () => {
    // 01 is fixed at 14 digits and carries no separator, so a parser that
    // splits on FNC1 alone loses everything after it.
    const parsed = parseGs1("0109506000134352" + "17260101");
    expect(parsed.isGs1).toBe(true);
    expect(parsed.gtin).toBe("09506000134352");
    expect(parsed.expiryDate).toBe("2026-01-01");
  });

  it("ends a variable-length element at the separator, not at a guessed length", () => {
    const parsed = parseGs1("0109506000134352" + "10ABC123" + GS + "21SER9");
    expect(parsed.lotNumber).toBe("ABC123");
    expect(parsed.serialNumber).toBe("SER9");
  });

  it("lets a variable-length element run to the end when nothing follows", () => {
    const parsed = parseGs1("0109506000134352" + "10BATCH-2026");
    expect(parsed.lotNumber).toBe("BATCH-2026");
    expect(parsed.unparsed).toBeUndefined();
  });

  it("keeps a batch that looks like another AI intact", () => {
    // "0000" is a legal batch. Without the separator rule it reads as the
    // start of a further element.
    const parsed = parseGs1("0109506000134352" + "100000" + GS + "21S1");
    expect(parsed.lotNumber).toBe("0000");
    expect(parsed.serialNumber).toBe("S1");
  });

  it("reads day 00 as the last day of the month", () => {
    // Read literally it is an invalid date, and an expiry that fails to parse
    // is an expiry that blocks nothing.
    expect(parseGs1Date("260200")).toBe("2026-02-28");
    expect(parseGs1Date("240200")).toBe("2024-02-29");
    expect(parseGs1Date("261200")).toBe("2026-12-31");
  });

  it("reads an ordinary day as itself", () => {
    // The control: without it the rule above would also pass against a parser
    // that returned month-end for every date it saw.
    expect(parseGs1Date("260215")).toBe("2026-02-15");
  });

  it("refuses a date it cannot make sense of", () => {
    expect(parseGs1Date("261301")).toBeUndefined();
    expect(parseGs1Date("2612")).toBeUndefined();
    expect(parseGs1Date("abcdef")).toBeUndefined();
  });

  it("strips a symbology identifier the wedge prepended", () => {
    const parsed = parseGs1("]C1" + "0109506000134352" + "10L1");
    expect(parsed.gtin).toBe("09506000134352");
    expect(parsed.lotNumber).toBe("L1");
  });

  it("ignores a leading separator, which is structure rather than data", () => {
    const parsed = parseGs1(GS + "0109506000134352" + "10L2");
    expect(parsed.gtin).toBe("09506000134352");
    expect(parsed.lotNumber).toBe("L2");
  });

  it("treats a plain SKU as not GS1 and invents nothing", () => {
    // Most scans are a plain code. Guessing AIs out of one produces a
    // plausible lot number from a product code, which is the worst outcome
    // available: wrong data that looks right.
    const parsed = parseGs1("SKU-12345");
    expect(parsed.isGs1).toBe(false);
    expect(parsed.gtin).toBeUndefined();
    expect(parsed.lotNumber).toBeUndefined();
    expect(parsed.raw).toBe("SKU-12345");
  });

  it("does not claim GS1 for digits that merely start with a known AI", () => {
    // A numeric SKU beginning "10" is not a batch element.
    expect(parseGs1("1099999").isGs1).toBe(false);
  });

  it("always returns the raw scan alongside the interpretation", () => {
    const payload = "0109506000134352" + GS + "10L1";
    expect(parseGs1(payload).raw).toBe(payload);
  });

  it("preserves what it could not attribute rather than discarding it", () => {
    const parsed = parseGs1("0109506000134352" + "!!broken");
    expect(parsed.gtin).toBe("09506000134352");
    expect(parsed.unparsed).toBe("!!broken");
  });
});
