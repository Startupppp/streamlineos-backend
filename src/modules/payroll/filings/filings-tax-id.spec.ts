import { resolveStatutoryTaxId } from "./filings.service";

describe("resolveStatutoryTaxId", () => {
  it("prefers the canonical tax identifier", () => {
    expect(resolveStatutoryTaxId("CANONICAL-TAX", "CANONICAL-PAN")).toBe("CANONICAL-TAX");
  });

  it("falls back to the canonical PAN when no tax identifier is stored", () => {
    expect(resolveStatutoryTaxId(null, "CANONICAL-PAN")).toBe("CANONICAL-PAN");
  });

  it("treats a blank tax identifier as absent rather than as a value", () => {
    expect(resolveStatutoryTaxId("   ", "CANONICAL-PAN")).toBe("CANONICAL-PAN");
  });

  it("returns null when neither identifier is stored", () => {
    expect(resolveStatutoryTaxId(null, null)).toBeNull();
  });
});
