import {
  DEFAULT_GRADE_POLICY,
  approvalRequired,
  decideGradeMove,
} from "./internal-grade-rules";

describe("decideGradeMove", () => {
  it("allows a lateral move", () => {
    expect(decideGradeMove(5, 5)).toEqual({ allowed: true, kind: "lateral" });
  });

  it("allows one grade up", () => {
    expect(decideGradeMove(5, 6)).toEqual({ allowed: true, kind: "step-up" });
  });

  it("refuses two grades up and says how far", () => {
    const decision = decideGradeMove(5, 7);
    expect(decision.allowed).toBe(false);
    expect(decision.kind).toBe("leap");
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.reason).toContain("2 grades above yours");
    expect(decision.reason).toContain("one grade");
  });

  /**
   * People move sideways and downwards on purpose — out of management, into a
   * different function. A rule that refused it would be a rule against the
   * main reason internal mobility exists.
   */
  it("allows a step down by default", () => {
    expect(decideGradeMove(7, 5)).toEqual({ allowed: true, kind: "step-down" });
  });

  it("refuses a step down when the policy says so", () => {
    const decision = decideGradeMove(7, 5, { ...DEFAULT_GRADE_POLICY, allowStepDown: false });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.reason).toContain("below your current grade");
  });

  it("honours a wider policy", () => {
    expect(decideGradeMove(5, 7, { maxStepsUp: 2, allowStepDown: true })).toEqual({
      allowed: true,
      kind: "step-up",
    });
    const decision = decideGradeMove(5, 8, { maxStepsUp: 2, allowStepDown: true });
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.reason).toContain("2 grades at most");
  });

  /**
   * Most openings will never carry a level. Refusing every one of them would
   * make the rule a wall rather than a rule, and the org that wants it
   * enforced is the org that grades its jobs.
   */
  it("allows when either side is ungraded", () => {
    expect(decideGradeMove(null, 9)).toEqual({ allowed: true, kind: "ungraded" });
    expect(decideGradeMove(9, null)).toEqual({ allowed: true, kind: "ungraded" });
    expect(decideGradeMove(null, null)).toEqual({ allowed: true, kind: "ungraded" });
  });

  /**
   * Rank zero is a real rank. A falsy check instead of a null check would make
   * the lowest grade in every org behave as ungraded, which is precisely the
   * grade the rule matters most for.
   */
  it("treats rank 0 as a rank, not as missing", () => {
    expect(decideGradeMove(0, 0)).toEqual({ allowed: true, kind: "lateral" });
    expect(decideGradeMove(0, 3).allowed).toBe(false);
  });

  it("gives every refusal a sentence that ends", () => {
    const refusals = [
      decideGradeMove(1, 9),
      decideGradeMove(9, 1, { maxStepsUp: 1, allowStepDown: false }),
    ];
    for (const decision of refusals) {
      if (decision.allowed) throw new Error("expected a refusal");
      expect(decision.reason.endsWith(".")).toBe(true);
    }
  });
});

describe("approvalRequired", () => {
  it("asks the manager when there is one", () => {
    expect(approvalRequired(42)).toBe("PENDING");
  });

  /**
   * An org with no head on the applicant's department would otherwise produce
   * an application that can never advance, and a queue nobody owns is
   * indistinguishable from a bug.
   */
  it("records NOT_REQUIRED rather than a queue nobody owns", () => {
    expect(approvalRequired(null)).toBe("NOT_REQUIRED");
  });

  /**
   * Membership ids are serials starting at 1, but a falsy check here would be
   * one schema change away from exempting a real manager.
   */
  it("does not treat membership 0 as absent", () => {
    expect(approvalRequired(0)).toBe("PENDING");
  });
});
