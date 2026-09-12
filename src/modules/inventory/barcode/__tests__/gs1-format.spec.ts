import { formatGs1, formatGs1Date, parseGs1 } from "../gs1";

const GS = "\x1D";

/**
 * G4 — the label encoder, checked against the decoder that has to read it.
 *
 * The failure this exists to prevent is not a malformed string. It is a
 * well-formed one that the warehouse's own scanner resolves as a *different*
 * batch — an encoder that puts a variable-length element between two fixed ones,
 * or emits a trailing separator as data, produces a label that looks correct and
 * scans wrong. So the assertion is the round trip through `parseGs1`, not the
 * shape of the string.
 */
describe("G4 — building a GS1 element string for a label", () => {
  it("puts the fixed-length AIs first and separates only the variable ones", () => {
    // 01 is 14 digits and 17 is 6, both consumed by count; 10 is variable and is
    // last, so it needs no separator after it.
    expect(
      formatGs1({ gtin: "08901234567890", lotNumber: "LOT-A1", expiryDate: "2027-03-31" }),
    ).toBe("01089012345678901727033110LOT-A1");

    // Two variable-length elements: FNC1 between them, none at the end.
    expect(
      formatGs1({ gtin: "08901234567890", lotNumber: "LOT-A1", serialNumber: "SN-9" }),
    ).toBe(`010890123456789010LOT-A1${GS}21SN-9`);
  });

  it("round-trips through the parser this module already ships", () => {
    const encoded = formatGs1({
      gtin: "08901234567890",
      lotNumber: "BATCH/2026-07",
      expiryDate: "2026-12-01",
      serialNumber: "SN-000123",
    });
    expect(encoded).not.toBeNull();

    const parsed = parseGs1(encoded!);
    expect(parsed.isGs1).toBe(true);
    expect(parsed.gtin).toBe("08901234567890");
    expect(parsed.lotNumber).toBe("BATCH/2026-07");
    expect(parsed.expiryDate).toBe("2026-12-01");
    expect(parsed.serialNumber).toBe("SN-000123");
    expect(parsed.unparsed).toBeUndefined();
  });

  it("pads a shorter GTIN to fourteen digits rather than emitting a short element", () => {
    // An EAN-13 is the same number with a leading zero. A reader consumes AI 01
    // by count, so a 13-digit value would eat the first digit of whatever follows.
    const encoded = formatGs1({ gtin: "8901234567890", lotNumber: "L1" });
    expect(encoded).toBe("010890123456789010L1");
    expect(parseGs1(encoded!).gtin).toBe("08901234567890");
  });

  it("returns null when there is no GTIN, because that is not a GS1 string", () => {
    // `parseGs1` requires AI 01 before it will claim a payload is GS1 at all, so
    // emitting `10LOT-1` alone would print a label that scans as the literal text
    // "10LOT-1" — and `lookup` would then resolve it as a SKU that does not exist.
    expect(formatGs1({ lotNumber: "LOT-1", expiryDate: "2027-01-01" })).toBeNull();
    // A SKU sitting in the barcode column is common and is not a GTIN.
    expect(formatGs1({ gtin: "WIDGET-BLUE-L", lotNumber: "LOT-1" })).toBeNull();
    expect(formatGs1({ gtin: "  " })).toBeNull();
  });

  it("omits an element the label does not have", () => {
    expect(formatGs1({ gtin: "08901234567890" })).toBe("0108901234567890");
    expect(parseGs1("0108901234567890").lotNumber).toBeUndefined();
  });

  it("transmits a date as YYMMDD and ignores anything that is not one", () => {
    expect(formatGs1Date("2027-03-31")).toBe("270331");
    expect(formatGs1Date("2026-12-01")).toBe("261201");
    expect(formatGs1Date(null)).toBeUndefined();
    expect(formatGs1Date("31/03/2027")).toBeUndefined();
    expect(formatGs1Date("")).toBeUndefined();
  });
});
