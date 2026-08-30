import { PgDialect } from "drizzle-orm/pg-core";
import type { ProbationCoverage } from "../../lifecycle/probation-coverage";
import { probationCoveringPredicate } from "../../lifecycle/probation-review-reader.service";
import {
  PROBATION_LEAVE_REFUSAL,
  decideProbationLeave,
} from "../probation-leave-restriction";

const COVERAGES: ProbationCoverage[] = ["on-probation", "past-probation", "no-record"];

describe("probation leave restriction matrix", () => {
  it("refuses an employee within probation, naming the policy as the reason", () => {
    expect(
      decideProbationLeave({ probationRestricted: true, coverage: "on-probation" }),
    ).toEqual({ allowed: false, reason: PROBATION_LEAVE_REFUSAL });
    expect(PROBATION_LEAVE_REFUSAL).toContain("probation period");
    expect(PROBATION_LEAVE_REFUSAL).toContain("Contact HR");
  });

  it("allows an employee past probation", () => {
    expect(
      decideProbationLeave({ probationRestricted: true, coverage: "past-probation" }),
    ).toEqual({ allowed: true });
  });

  it("allows when probation was never recorded — the decided meaning of unknown", () => {
    expect(
      decideProbationLeave({ probationRestricted: true, coverage: "no-record" }),
    ).toEqual({ allowed: true });
  });

  it("leaves every coverage untouched when the policy flag is off, unset or absent", () => {
    for (const coverage of COVERAGES) {
      expect(decideProbationLeave({ probationRestricted: false, coverage })).toEqual({
        allowed: true,
      });
      expect(decideProbationLeave({ probationRestricted: null, coverage })).toEqual({
        allowed: true,
      });
      expect(decideProbationLeave({ probationRestricted: undefined, coverage })).toEqual({
        allowed: true,
      });
    }
  });

  it("has no override escape hatch — the decision takes no actor and no permission", () => {
    expect(decideProbationLeave.length).toBe(1);
    const decision = decideProbationLeave({
      probationRestricted: true,
      coverage: "on-probation",
    });
    expect(decision.allowed).toBe(false);
  });

  it("treats probation ending on the requested start date as still inside probation", () => {
    const compiled = new PgDialect().sqlToQuery(probationCoveringPredicate("2026-03-01"));
    expect(compiled.params).toEqual(["2026-03-01"]);
    expect(compiled.sql).toContain(">=");
    expect(compiled.sql).toContain("coalesce");
    expect(compiled.sql).toContain("'in_probation', 'review_due', 'extended'");
  });
});
