import {
  REVERSIBILITY_CLASSES,
  type ReversibilityClass,
} from "../../db/schema/crm/autonomous-decisions";
import { PROPOSED_ACTIONS } from "../../db/schema/crm/data-quality";
import {
  ACTION_REVERSIBILITY,
  SEVERITY_WEIGHTS,
  strictestReversibility,
  weightedOpenCount,
} from "./finding-vocabulary";

describe("the queue's vocabulary", () => {
  /**
   * The ticket's second criterion, asserted rather than trusted: the queue and
   * Phase 1's decision record use ONE set of reversibility classes. A parallel
   * set that means almost the same thing is how the review feed and this queue
   * would start reading differently.
   */
  it("uses the decision record's reversibility classes, not a parallel set", () => {
    expect([...REVERSIBILITY_CLASSES]).toEqual(["instant", "hold", "irreversible"]);
    for (const value of Object.values(ACTION_REVERSIBILITY))
      expect(REVERSIBILITY_CLASSES).toContain(value);
  });

  /**
   * An action with no declared class would default to whatever the producer
   * happened to write, which is exactly the disagreement the table exists to
   * prevent.
   */
  it("declares a reversibility class for every proposed action", () => {
    for (const action of PROPOSED_ACTIONS)
      expect(ACTION_REVERSIBILITY[action]).toBeDefined();

    expect(Object.keys(ACTION_REVERSIBILITY).sort()).toEqual([...PROPOSED_ACTIONS].sort());
  });

  describe("strictestReversibility", () => {
    it("is instant when there is nothing to take back", () => {
      expect(strictestReversibility([])).toBe("instant");
    });

    it("is instant when every member is", () => {
      expect(strictestReversibility(["instant", "instant", "instant"])).toBe("instant");
    });

    /**
     * The load-bearing case. One irreversible item in four hundred makes the
     * whole decision irreversible — offering an undo that silently skips part of
     * the selection is worse than refusing, because the person believes it
     * worked.
     */
    it("is irreversible when a single member is", () => {
      const classes: ReversibilityClass[] = Array.from({ length: 400 }, (_, index) =>
        index === 137 ? "irreversible" : "instant",
      );
      expect(strictestReversibility(classes)).toBe("irreversible");
    });

    it("prefers hold over instant, and irreversible over hold", () => {
      expect(strictestReversibility(["instant", "hold"])).toBe("hold");
      expect(strictestReversibility(["hold", "irreversible"])).toBe("irreversible");
      expect(strictestReversibility(["irreversible", "instant"])).toBe("irreversible");
    });

    it("does not depend on the order it is given", () => {
      expect(strictestReversibility(["irreversible", "hold", "instant"])).toBe(
        strictestReversibility(["instant", "hold", "irreversible"]),
      );
    });
  });

  describe("weightedOpenCount", () => {
    it("is zero for an empty queue", () => {
      expect(weightedOpenCount([])).toBe(0);
    });

    /**
     * The whole content of the weights table: a small number of severe findings
     * has to be able to outrank a large number of trivial ones, or the health
     * figure just counts rows and every tenant's worst problem is invisible
     * behind their most common one.
     */
    it("lets two high findings outrank a dozen low ones", () => {
      const twoSevere = weightedOpenCount([{ severity: "high", count: 2 }]);
      const twelveTrivial = weightedOpenCount([{ severity: "low", count: 12 }]);
      expect(twoSevere).toBeGreaterThan(twelveTrivial);
    });

    it("adds the severities together", () => {
      expect(
        weightedOpenCount([
          { severity: "high", count: 1 },
          { severity: "medium", count: 1 },
          { severity: "low", count: 1 },
        ]),
      ).toBe(SEVERITY_WEIGHTS.high + SEVERITY_WEIGHTS.medium + SEVERITY_WEIGHTS.low);
    });

    it("keeps the weights strictly ordered", () => {
      expect(SEVERITY_WEIGHTS.high).toBeGreaterThan(SEVERITY_WEIGHTS.medium);
      expect(SEVERITY_WEIGHTS.medium).toBeGreaterThan(SEVERITY_WEIGHTS.low);
      expect(SEVERITY_WEIGHTS.low).toBeGreaterThan(0);
    });
  });
});
