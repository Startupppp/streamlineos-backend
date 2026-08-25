import { planResolutionReversal, type ReversibleResolution } from "./resolution-reversal";

/**
 * The refusals are the point.
 *
 * A reversibility class that only ever describes something is documentation. The
 * fifth acceptance criterion is that a resolution is reversible where its class
 * says it is and **refuses where it does not**, and this is the only place that
 * distinction is decided — so every branch is asserted here rather than inferred
 * from a service that happens to call it.
 */
describe("planResolutionReversal", () => {
  const NOW = new Date("2026-08-25T12:00:00.000Z");

  const resolution = (patch: Partial<ReversibleResolution> = {}): ReversibleResolution => ({
    action: "apply",
    reversibility: "instant",
    holdUntil: null,
    reversedAt: null,
    resolvedCount: 12,
    ...patch,
  });

  it("allows an instant application, and says records have to be put back", () => {
    const plan = planResolutionReversal(resolution(), NOW);
    expect(plan).toEqual({ ok: true, action: "revert-and-reopen" });
  });

  /**
   * A dismissal touched no record, so reopening the findings is the whole undo.
   * Naming it separately lets the caller skip the executor rather than
   * dispatching a no-op four hundred times.
   */
  it("names a dismissal's undo as a reopen, not a revert", () => {
    const plan = planResolutionReversal(resolution({ action: "dismiss" }), NOW);
    expect(plan).toEqual({ ok: true, action: "reopen" });
  });

  it("refuses an irreversible decision outright", () => {
    const plan = planResolutionReversal(resolution({ reversibility: "irreversible" }), NOW);
    expect(plan).toMatchObject({ ok: false, reason: "class-refuses" });
  });

  /**
   * Irreversible refuses even when everything else about the decision is fine
   * and recent. The class is the answer, not the circumstances — offering the
   * button anyway teaches people the undo works when it does not.
   */
  it("refuses an irreversible decision even one second after it was taken", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "irreversible", resolvedCount: 400 }),
      new Date(NOW.getTime() + 1000),
    );
    expect(plan.ok).toBe(false);
  });

  it("allows a hold inside its window", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "hold", holdUntil: new Date(NOW.getTime() + 60_000) }),
      NOW,
    );
    expect(plan).toEqual({ ok: true, action: "revert-and-reopen" });
  });

  it("refuses a hold once the window has passed", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "hold", holdUntil: new Date(NOW.getTime() - 1) }),
      NOW,
    );
    expect(plan).toMatchObject({ ok: false, reason: "hold-expired" });
  });

  /** The boundary belongs to the past: at the deadline, the window has closed. */
  it("refuses a hold exactly at its deadline", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "hold", holdUntil: new Date(NOW.getTime()) }),
      NOW,
    );
    expect(plan).toMatchObject({ ok: false, reason: "hold-expired" });
  });

  /**
   * A hold with no deadline is either open forever or already closed, and there
   * is no safe way to guess which — so it refuses rather than picking one.
   */
  it("refuses a hold that never recorded a deadline", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "hold", holdUntil: null }),
      NOW,
    );
    expect(plan).toMatchObject({ ok: false, reason: "hold-window-missing" });
  });

  it("refuses a decision somebody already reversed", () => {
    const plan = planResolutionReversal(resolution({ reversedAt: NOW }), NOW);
    expect(plan).toMatchObject({ ok: false, reason: "already-reversed" });
  });

  /**
   * A bulk decision where every item failed changed nothing, and "undoing" it
   * would reopen findings that were never closed.
   */
  it("refuses a decision that resolved nothing", () => {
    const plan = planResolutionReversal(resolution({ resolvedCount: 0 }), NOW);
    expect(plan).toMatchObject({ ok: false, reason: "nothing-resolved" });
  });

  it("puts already-reversed ahead of the class check", () => {
    const plan = planResolutionReversal(
      resolution({ reversibility: "irreversible", reversedAt: NOW }),
      NOW,
    );
    expect(plan).toMatchObject({ ok: false, reason: "already-reversed" });
  });

  it("explains every refusal in a sentence a person can read", () => {
    const refusals = [
      resolution({ reversedAt: NOW }),
      resolution({ resolvedCount: 0 }),
      resolution({ reversibility: "irreversible" }),
      resolution({ reversibility: "hold", holdUntil: null }),
      resolution({ reversibility: "hold", holdUntil: new Date(NOW.getTime() - 1) }),
    ].map((input) => planResolutionReversal(input, NOW));

    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.explanation).toMatch(/\.$/);
    }
  });
});
