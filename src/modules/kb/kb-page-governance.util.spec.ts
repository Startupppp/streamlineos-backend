import { computeVerificationInterval, shouldResetTrust } from "./kb-page-governance.util";

describe("computeVerificationInterval", () => {
  it("returns 180 for policy", () => {
    expect(computeVerificationInterval("policy")).toBe(180);
  });

  it("returns 90 for sop", () => {
    expect(computeVerificationInterval("sop")).toBe(90);
  });

  it("returns 120 for support_article", () => {
    expect(computeVerificationInterval("support_article")).toBe(120);
  });

  it("returns 90 for runbook", () => {
    expect(computeVerificationInterval("runbook")).toBe(90);
  });

  it("returns 365 for note", () => {
    expect(computeVerificationInterval("note")).toBe(365);
  });

  it("returns 365 for decision_record", () => {
    expect(computeVerificationInterval("decision_record")).toBe(365);
  });

  it("uses override when provided and positive", () => {
    expect(computeVerificationInterval("policy", 30)).toBe(30);
  });

  it("uses override even for note", () => {
    expect(computeVerificationInterval("note", 14)).toBe(14);
  });

  it("ignores override of zero and uses default", () => {
    expect(computeVerificationInterval("policy", 0)).toBe(180);
  });

  it("ignores negative override and uses default", () => {
    expect(computeVerificationInterval("sop", -5)).toBe(90);
  });
});

describe("shouldResetTrust", () => {
  it("returns true when content changed and trust is verified", () => {
    expect(shouldResetTrust("verified", true)).toBe(true);
  });

  it("returns false when content did not change", () => {
    expect(shouldResetTrust("verified", false)).toBe(false);
  });

  it("returns false when trust is unverified even with content change", () => {
    expect(shouldResetTrust("unverified", true)).toBe(false);
  });

  it("returns false when trust is verification_expired with content change", () => {
    expect(shouldResetTrust("verification_expired", true)).toBe(false);
  });

  it("returns false when trust is unverified and content unchanged", () => {
    expect(shouldResetTrust("unverified", false)).toBe(false);
  });
});
