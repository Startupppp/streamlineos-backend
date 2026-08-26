import { evaluateAutonomousWrite, isUnlimited, upgradePrompt } from "./autonomous-write-guard";

const REQUEST = { kind: "party.created" as const, limitKey: "parties", limit: 100, current: 40 };

describe("evaluateAutonomousWrite", () => {
  it("allows a write that fits", () => {
    expect(evaluateAutonomousWrite(REQUEST)).toEqual({ allowed: true });
  });

  it("allows a write that exactly reaches the limit", () => {
    expect(evaluateAutonomousWrite({ ...REQUEST, current: 99 }).allowed).toBe(true);
  });

  it("refuses the one that would exceed it", () => {
    // The cap has to bite, or it is a cap on the people who use the product
    // carefully and on nobody else.
    expect(evaluateAutonomousWrite({ ...REQUEST, current: 100 }).allowed).toBe(false);
  });

  it("counts what the write actually adds, not one", () => {
    expect(evaluateAutonomousWrite({ ...REQUEST, current: 95, adding: 5 }).allowed).toBe(true);
    expect(evaluateAutonomousWrite({ ...REQUEST, current: 95, adding: 6 }).allowed).toBe(false);
  });

  it("treats a negative limit as unlimited rather than as zero", () => {
    // Reading -1 as zero would refuse every autonomous write on an unlimited
    // plan -- the exact inverse of the intent, discovered by the largest
    // customers first.
    expect(isUnlimited(-1)).toBe(true);
    expect(evaluateAutonomousWrite({ ...REQUEST, limit: -1, current: 10_000 }).allowed).toBe(true);
  });

  it("records the refusal as skipped, not failed", () => {
    // Nothing went wrong. A tenant reading the review feed should see a decision
    // rather than an error they might report as a bug.
    const verdict = evaluateAutonomousWrite({ ...REQUEST, current: 100 });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.decision.outcome).toBe("skipped");
    expect(verdict.decision.kind).toBe("party.created");
  });

  it("carries the numbers into the decision, so the feed can explain itself", () => {
    const verdict = evaluateAutonomousWrite({ ...REQUEST, current: 120 });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.decision.decision).toEqual({
      refusedBy: "plan-limit",
      limitKey: "parties",
      limit: 100,
      current: 120,
      adding: 1,
    });
  });

  it("says the limit and the count in words a person can act on", () => {
    const verdict = evaluateAutonomousWrite({ ...REQUEST, current: 100 });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("100");
    expect(verdict.reason).toContain("parties");
  });
});

describe("upgradePrompt", () => {
  it("tells somebody how to stop having the problem", () => {
    // "Limit reached" tells them they have one. Naming the limit tells them what
    // to do about it.
    const verdict = evaluateAutonomousWrite({ ...REQUEST, current: 100 });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    const prompt = upgradePrompt(verdict);

    expect(prompt).toContain("parties");
    expect(prompt).toContain("resumes this automatically");
  });

  it("says existing records are safe, because that is the first fear", () => {
    const verdict = evaluateAutonomousWrite({ ...REQUEST, current: 100 });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;

    expect(upgradePrompt(verdict)).toContain("unaffected");
  });
});
