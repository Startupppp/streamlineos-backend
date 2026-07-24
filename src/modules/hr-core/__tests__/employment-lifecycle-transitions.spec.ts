/**
 * Pure contract tests for employment lifecycle transition matrix.
 * Service integration is covered via onboarding-complete-lifecycle tests.
 */

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  CANDIDATE: ["PRE_JOINING", "EXITED"],
  PRE_JOINING: ["ONBOARDING", "EXITED"],
  ONBOARDING: ["ACTIVE", "PROBATION", "EXITED"],
  ACTIVE: ["PROBATION", "NOTICE", "SUSPENDED", "EXITED"],
  PROBATION: ["CONFIRMED", "ACTIVE", "NOTICE", "EXITED"],
  CONFIRMED: ["NOTICE", "SUSPENDED", "EXITED"],
  NOTICE: ["EXITED", "ACTIVE"],
  EXITED: ["ALUMNI"],
  ALUMNI: [],
  SUSPENDED: ["ACTIVE", "NOTICE", "EXITED"],
};

function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

describe("Employment lifecycle transition matrix (Phase 2.2)", () => {
  it("allows onboarding complete path", () => {
    expect(canTransition("ONBOARDING", "PROBATION")).toBe(true);
    expect(canTransition("ONBOARDING", "ACTIVE")).toBe(true);
  });

  it("allows probation confirmation path", () => {
    expect(canTransition("PROBATION", "CONFIRMED")).toBe(true);
  });

  it("blocks illegal alumni reactivation", () => {
    expect(canTransition("ALUMNI", "ACTIVE")).toBe(false);
  });

  it("requires intermediate status from pre-joining", () => {
    expect(canTransition("PRE_JOINING", "ONBOARDING")).toBe(true);
    expect(canTransition("PRE_JOINING", "PROBATION")).toBe(false);
  });
});
