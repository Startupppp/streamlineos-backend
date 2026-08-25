import { planReversal, type ReversibleDecision, type TargetState } from "./reversal-plan";

const base: ReversibleDecision = {
  kind: "stage.advanced",
  outcome: "applied",
  reversibility: "instant",
  reversedAt: null,
  dealId: "deal-1",
  activityId: null,
  partyId: null,
  decision: { fromStage: "QUALIFIED", toStage: "NEGOTIATION" },
};

const decision = (over: Partial<ReversibleDecision> = {}): ReversibleDecision => ({ ...base, ...over });
const deal = (stage: string | null): TargetState => ({ kind: "deal", stage });
const activity = (over: Partial<Extract<TargetState, { kind: "activity" }>> = {}): TargetState => ({
  kind: "activity",
  deletedAt: null,
  completedAt: null,
  ...over,
});

describe("planReversal", () => {
  describe("the guards, in the order a reviewer would ask them", () => {
    it("refuses one that was already reversed", () => {
      const result = planReversal(decision({ reversedAt: new Date() }), deal("NEGOTIATION"));
      expect(result).toMatchObject({ ok: false, reason: "already-reversed" });
    });

    it("refuses one that never applied, because nothing changed", () => {
      // A skipped decision records the system choosing NOT to act. That is worth
      // reading and meaningless to undo.
      for (const outcome of ["skipped", "failed", "held"] as const) {
        const result = planReversal(decision({ outcome }), deal("NEGOTIATION"));
        expect(result).toMatchObject({ ok: false, reason: "never-applied" });
      }
    });

    it("refuses one that is not instantly reversible, and says which kind of un-undoable it is", () => {
      const held = planReversal(decision({ reversibility: "hold" }), deal("NEGOTIATION"));
      expect(held).toMatchObject({ ok: false, reason: "not-reversible" });

      /**
       * True on both sides of the window, because this refusal is reached far
       * more often after the send than during it: `quote.sent` keeps its `hold`
       * class permanently, so a reversal clicked on last week's quote lands
       * here and must not be told to go and cancel it in a window that closed.
       */
      const explanation = (held as { explanation: string }).explanation;
      expect(explanation).toContain("hold window");
      expect(explanation).toContain("sent");

      const gone = planReversal(decision({ reversibility: "irreversible" }), deal("NEGOTIATION"));
      expect((gone as { explanation: string }).explanation).toContain("left the building");
    });

    it("refuses when the record is gone", () => {
      expect(planReversal(decision(), null)).toMatchObject({ ok: false, reason: "target-missing" });
    });
  });

  describe("stage.advanced", () => {
    it("plans a move back to the stage the deal came from", () => {
      expect(planReversal(decision(), deal("NEGOTIATION"))).toEqual({
        ok: true,
        action: "restore-stage",
        dealId: "deal-1",
        toStage: "QUALIFIED",
        fromStage: "NEGOTIATION",
      });
    });

    /**
     * The guard that makes one-click safe, and the reason this file exists.
     *
     * Without it, a reviewer clicking "reverse" on a week-old entry silently
     * drags a deal back from wherever a human has since moved it — undoing a
     * person's judgement while appearing to undo the system's.
     */
    it("refuses when a human has moved the deal on since", () => {
      const result = planReversal(decision(), deal("CLOSED_WON"));
      expect(result).toMatchObject({ ok: false, reason: "changed-since" });
      expect((result as { explanation: string }).explanation).toContain("CLOSED_WON");
    });

    it("refuses when the ledger does not say where it came from", () => {
      const result = planReversal(decision({ decision: { toStage: "NEGOTIATION" } }), deal("NEGOTIATION"));
      expect(result).toMatchObject({ ok: false, reason: "target-missing" });
    });
  });

  describe("task.extracted", () => {
    const task = decision({ kind: "task.extracted", dealId: null, activityId: "act-1", decision: null });

    it("plans a delete of the task it created", () => {
      expect(planReversal(task, activity())).toEqual({
        ok: true,
        action: "delete-activity",
        activityId: "act-1",
      });
    });

    it("refuses to erase a task somebody already completed", () => {
      // The system creating the task may have been wrong; the human doing the
      // work was not, and deleting it removes the record that it happened.
      const result = planReversal(task, activity({ completedAt: new Date() }));
      expect(result).toMatchObject({ ok: false, reason: "changed-since" });
    });

    it("refuses one already deleted, rather than deleting twice", () => {
      expect(planReversal(task, activity({ deletedAt: new Date() }))).toMatchObject({
        ok: false,
        reason: "target-missing",
      });
    });
  });

  describe("party.created", () => {
    const party = decision({ kind: "party.created", dealId: null, partyId: "party-1", decision: null });

    it("plans a delete of the party it created", () => {
      expect(planReversal(party, { kind: "party", deletedAt: null })).toEqual({
        ok: true,
        action: "delete-party",
        partyId: "party-1",
      });
    });

    it("refuses one already deleted", () => {
      expect(planReversal(party, { kind: "party", deletedAt: new Date() })).toMatchObject({
        ok: false,
        reason: "target-missing",
      });
    });
  });

  it("refuses a sent quote outright", () => {
    const quote = decision({ kind: "quote.sent", reversibility: "hold" });
    expect(planReversal(quote, null)).toMatchObject({ ok: false, reason: "not-reversible" });
  });

  it("never returns a plan whose target does not match the decision's kind", () => {
    // A mismatched target is how a reversal deletes the wrong row. Every kind is
    // checked against the shape it expects rather than trusting the caller.
    const task = decision({ kind: "task.extracted", activityId: "act-1" });
    expect(planReversal(task, deal("NEGOTIATION"))).toMatchObject({ ok: false });

    const stage = decision({ kind: "stage.advanced" });
    expect(planReversal(stage, activity())).toMatchObject({ ok: false });
  });
});
