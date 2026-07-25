import { FILING_CAPABILITY } from "../filings.service";

describe("FILING_CAPABILITY (export-only honesty)", () => {
  it("declares export-only mode with no automatic filing or remittance", () => {
    expect(FILING_CAPABILITY.mode).toBe("export_only");
    expect(FILING_CAPABILITY.automaticFiling).toBe(false);
    expect(FILING_CAPABILITY.automaticRemittance).toBe(false);
    expect(FILING_CAPABILITY.providerDependent).toBe(true);
  });

  it("uses honest status label for UI and exports", () => {
    expect(FILING_CAPABILITY.honestyLabel).toBe(
      "Export prepared — external filing required",
    );
    expect(FILING_CAPABILITY.note.toLowerCase()).toMatch(/not automatic|external/);
  });

  it("lists supported India statutory export types", () => {
    expect(FILING_CAPABILITY.supportedTypes).toEqual(
      expect.arrayContaining(["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"]),
    );
  });

  it("pins India rule bundle version and CSV artifact format", () => {
    expect(FILING_CAPABILITY.ruleBundleVersion).toMatch(/^IN-/);
    expect(FILING_CAPABILITY.artifactFormat).toBe("csv");
  });
});
