import {
  CONFIDENTIALITY_NOTICE,
  DEFAULT_ELIGIBILITY,
  decideEligibility,
  managerMaySee,
  monthsBetween,
  type EmploymentFacts,
} from "./internal-eligibility";

const NOW = new Date("2026-09-24T00:00:00.000Z");

const LONG_SERVING: EmploymentFacts = {
  lifecycleStatus: "ACTIVE",
  joiningDate: new Date("2024-01-10T00:00:00.000Z"),
  probationEndDate: new Date("2024-04-10T00:00:00.000Z"),
  onNotice: false,
};

describe("decideEligibility", () => {
  it("allows an active employee past probation and the tenure bar", () => {
    expect(decideEligibility(LONG_SERVING, NOW)).toEqual({ eligible: true });
  });

  /**
   * The route is reachable by anybody holding a recruitment view permission,
   * which on some plans includes external recruiters. "Internal" is not a
   * synonym for "logged in".
   */
  it("refuses somebody with no employment record at all", () => {
    const decision = decideEligibility({ ...LONG_SERVING, lifecycleStatus: null }, NOW);
    expect(decision.eligible).toBe(false);
    if (decision.eligible) throw new Error("expected a refusal");
    expect(decision.reason).toContain("open to employees");
  });

  it("refuses a non-active employee", () => {
    for (const status of ["EXITED", "SUSPENDED", "ON_LEAVE"]) {
      expect(decideEligibility({ ...LONG_SERVING, lifecycleStatus: status }, NOW).eligible).toBe(
        false,
      );
    }
  });

  /**
   * Somebody serving notice is still ACTIVE and is still refused. An internal
   * move is a retention decision and a resignation already in flight is a
   * different conversation.
   */
  it("refuses somebody serving notice", () => {
    const decision = decideEligibility({ ...LONG_SERVING, onNotice: true }, NOW);
    expect(decision.eligible).toBe(false);
    if (decision.eligible) throw new Error("expected a refusal");
    expect(decision.reason).toContain("serving notice");
  });

  it("refuses somebody still on probation", () => {
    const decision = decideEligibility(
      { ...LONG_SERVING, probationEndDate: new Date("2027-01-01T00:00:00.000Z") },
      NOW,
    );
    expect(decision.eligible).toBe(false);
    if (decision.eligible) throw new Error("expected a refusal");
    expect(decision.reason).toContain("probation");
  });

  it("allows during probation when the policy says so", () => {
    const decision = decideEligibility(
      { ...LONG_SERVING, probationEndDate: new Date("2027-01-01T00:00:00.000Z") },
      NOW,
      { ...DEFAULT_ELIGIBILITY, allowDuringProbation: true },
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("refuses below the tenure bar and says how far off they are", () => {
    const decision = decideEligibility(
      { ...LONG_SERVING, joiningDate: new Date("2026-07-24T00:00:00.000Z") },
      NOW,
    );
    expect(decision.eligible).toBe(false);
    if (decision.eligible) throw new Error("expected a refusal");
    expect(decision.reason).toContain("You have 2");
  });

  it("allows exactly at the bar", () => {
    const decision = decideEligibility(
      { ...LONG_SERVING, joiningDate: new Date("2026-03-24T00:00:00.000Z") },
      NOW,
    );
    expect(decision).toEqual({ eligible: true });
  });

  /**
   * Unknown tenure refuses rather than passing. Treating a missing date as
   * "long enough" makes the bar optional for exactly the records that are
   * incomplete.
   */
  it("refuses when the joining date is not recorded", () => {
    const decision = decideEligibility({ ...LONG_SERVING, joiningDate: null }, NOW);
    expect(decision.eligible).toBe(false);
    if (decision.eligible) throw new Error("expected a refusal");
    expect(decision.reason).toContain("joining date is not recorded");
  });
});

describe("monthsBetween", () => {
  /**
   * Calendar months, not days divided by 30.44. An eligibility answer that
   * changes with the length of February is one nobody can explain to the person
   * it refused.
   */
  it("counts whole calendar months", () => {
    expect(monthsBetween(new Date("2026-01-10"), new Date("2026-07-10"))).toBe(6);
    expect(monthsBetween(new Date("2026-01-10"), new Date("2026-07-09"))).toBe(5);
    expect(monthsBetween(new Date("2026-01-10"), new Date("2026-07-11"))).toBe(6);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween(new Date("2025-11-01"), new Date("2026-02-01"))).toBe(3);
  });

  it("is not thrown off by February", () => {
    expect(monthsBetween(new Date("2026-01-31"), new Date("2026-03-31"))).toBe(2);
  });

  it("never goes negative for a future joining date", () => {
    expect(monthsBetween(new Date("2027-01-01"), new Date("2026-01-01"))).toBe(0);
  });
});

describe("managerMaySee", () => {
  /**
   * Confidential until interview. A manager who learns about an internal
   * application from a dashboard finds out before the person meant to tell
   * them, after which nobody in that organisation applies internally again.
   */
  it("hides an application before the interview stage", () => {
    expect(managerMaySee("APPLIED")).toBe(false);
    expect(managerMaySee("SHORTLISTED")).toBe(false);
  });

  it("shows it from the interview stage onwards", () => {
    expect(managerMaySee("INTERVIEWING")).toBe(true);
    expect(managerMaySee("OFFERED")).toBe(true);
    expect(managerMaySee("ACCEPTED")).toBe(true);
  });

  it("hides a withdrawn or rejected application that never reached interview", () => {
    expect(managerMaySee("REJECTED")).toBe(false);
    expect(managerMaySee("WITHDRAWN")).toBe(false);
  });

  it("tells the applicant when that happens, before they apply", () => {
    expect(CONFIDENTIALITY_NOTICE).toContain("interview stage");
    expect(CONFIDENTIALITY_NOTICE).toContain("current manager");
  });
});
