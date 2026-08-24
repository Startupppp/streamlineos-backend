import {
  listDecisionsQuerySchema,
  reverseDecisionSchema,
  setSwitchSchema,
} from "./autonomy-review.schemas";

describe("autonomy review schemas", () => {
  describe("the feed query", () => {
    it("defaults to a readable page of judgements", () => {
      const parsed = listDecisionsQuerySchema.parse({});
      expect(parsed.limit).toBe(25);
      // Routine filing is recorded but hidden, or one entry per inbound email
      // buries the decisions that actually need a human.
      expect(parsed.includeRoutine).toBe(false);
    });

    it("holds the platform page cap", () => {
      expect(() => listDecisionsQuerySchema.parse({ limit: 500 })).toThrow();
      expect(listDecisionsQuerySchema.parse({ limit: 100 }).limit).toBe(100);
      expect(() => listDecisionsQuerySchema.parse({ limit: 0 })).toThrow();
    });

    /**
     * The bug this schema was written around: `z.coerce.boolean()` makes every
     * non-empty string true, so `?includeRoutine=false` would have turned the
     * routine entries ON.
     */
    it("reads includeRoutine=false as false", () => {
      expect(listDecisionsQuerySchema.parse({ includeRoutine: "false" }).includeRoutine).toBe(false);
      expect(listDecisionsQuerySchema.parse({ includeRoutine: "true" }).includeRoutine).toBe(true);
      expect(listDecisionsQuerySchema.parse({ reversedOnly: "false" }).reversedOnly).toBe(false);
    });

    it("rejects an action type that is not one of ours", () => {
      expect(() => listDecisionsQuerySchema.parse({ kind: "deal.deleted" })).toThrow();
      expect(listDecisionsQuerySchema.parse({ kind: "stage.advanced" }).kind).toBe("stage.advanced");
    });

    it("rejects unknown keys rather than dropping them", () => {
      // A typo'd filter that is silently ignored looks like a filter that found
      // nothing, which is the most confusing possible outcome.
      expect(() => listDecisionsQuerySchema.parse({ mine: true })).toThrow();
    });
  });

  describe("reversing", () => {
    it("does not require a reason", () => {
      // Requiring a justification on a one-click undo is how the undo stops
      // being used, and an unexplained reversal still beats a silent edit.
      expect(reverseDecisionSchema.parse({})).toEqual({ consented: false });
    });

    it("defaults consent to false, so nothing reaches a dataset by accident", () => {
      expect(reverseDecisionSchema.parse({}).consented).toBe(false);
      expect(reverseDecisionSchema.parse({ consented: true }).consented).toBe(true);
    });

    it("trims and bounds the reason", () => {
      expect(reverseDecisionSchema.parse({ reason: "  wrong deal  " }).reason).toBe("wrong deal");
      expect(() => reverseDecisionSchema.parse({ reason: "x".repeat(501) })).toThrow();
      expect(() => reverseDecisionSchema.parse({ reason: "   " })).toThrow();
    });
  });

  describe("the kill switch", () => {
    it("accepts the wildcard and every real action type", () => {
      expect(setSwitchSchema.parse({ kind: "*", enabled: false }).kind).toBe("*");
      expect(setSwitchSchema.parse({ kind: "quote.sent", enabled: true }).enabled).toBe(true);
    });

    it("rejects an action type that does not exist", () => {
      expect(() => setSwitchSchema.parse({ kind: "everything", enabled: false })).toThrow();
    });

    it("requires enabled to be stated rather than assumed", () => {
      // A switch call that omits it would otherwise default one way and quietly
      // turn something on or off that the caller never mentioned.
      expect(() => setSwitchSchema.parse({ kind: "stage.advanced" })).toThrow();
    });
  });
});
