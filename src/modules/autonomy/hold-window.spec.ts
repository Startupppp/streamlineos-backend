import { clampHoldWindow, resolveHold, secondsRemaining, type HoldState } from "./hold-window";

/**
 * The window closed a minute before `NOW`, so every case below is one whose
 * window has genuinely run out unless it says otherwise. The old fixture put
 * `holdUntil` in the future and relied on the default `now`, which meant the
 * case named for expiry never tested expiry.
 */
const NOW = new Date("2026-08-24T12:01:00.000Z");

const held = (over: Partial<HoldState> = {}): HoldState => ({
  status: "held",
  holdUntil: new Date("2026-08-24T12:00:00.000Z"),
  ...over,
});

describe("resolveHold", () => {
  it("sends when the window ran out and nothing stopped it", () => {
    expect(resolveHold(held(), true, NOW)).toEqual({ action: "send" });
  });

  /**
   * The window is enforced here as well as by the runtime.
   *
   * `step.sleep` sets `run_after` and the claim gates on it, so this should
   * never fire in practice — which is exactly why it was never noticed that
   * `holdUntil` was declared, passed, and then never read. A hold is the one
   * action here that cannot be taken back, so it does not send on the strength
   * of the scheduler alone.
   */
  it("refuses to send a hold whose window has not run out", () => {
    const early = new Date("2026-08-24T11:59:00.000Z");
    expect(resolveHold(held(), true, early)).toEqual({ action: "skip", reason: "not-yet-due" });
  });

  /**
   * The runtime wakes on the database clock and this compares application
   * clocks, so a wake that is fractionally early is a skew artefact rather than
   * a scheduling fault — and stranding the hold at `held` over it would be a
   * worse bug than the one this guard prevents.
   */
  it("still sends one woken a few milliseconds early, because two clocks are involved", () => {
    const aHairEarly = new Date("2026-08-24T11:59:59.500Z");
    expect(resolveHold(held(), true, aHairEarly)).toEqual({ action: "send" });
  });

  /**
   * Order matters: an operator who killed quote sending has stopped this hold
   * whether or not its window happens to have run out yet. Checking the window
   * first would leave an early wake to expire with the switch already off.
   */
  it("cancels a hold that is not yet due when the switch went off", () => {
    const early = new Date("2026-08-24T11:59:00.000Z");
    expect(resolveHold(held(), false, early)).toEqual({ action: "cancel", reason: "switched-off" });
  });

  describe("never twice", () => {
    it("skips one a human already cancelled", () => {
      expect(resolveHold(held({ status: "cancelled" }), true, NOW)).toEqual({
        action: "skip",
        reason: "already-cancelled",
      });
    });

    /**
     * The restart case. A run resumed after the send already happened must not
     * send again — the status is the record of what happened, not a label.
     */
    it("skips one already sent", () => {
      expect(resolveHold(held({ status: "sent" }), true, NOW)).toEqual({
        action: "skip",
        reason: "already-sent",
      });
    });

    it("skips one that failed rather than retrying it into a customer's inbox", () => {
      expect(resolveHold(held({ status: "failed" }), true, NOW)).toEqual({
        action: "skip",
        reason: "failed",
      });
    });
  });

  /**
   * The kill switch is re-read on wake, not only when the hold was created. A
   * hold placed at nine and an operator killing quote sending at noon must not
   * still send at one — otherwise the switch stops new holds and lets the
   * already-decided, more dangerous ones through.
   */
  it("cancels a live hold when the switch went off during the window", () => {
    expect(resolveHold(held(), false, NOW)).toEqual({ action: "cancel", reason: "switched-off" });
  });

  it("does not resurrect a cancelled hold when the switch is off", () => {
    // Order matters: terminal states are checked before the switch, so the
    // cancellation reason recorded stays the human's rather than the operator's.
    expect(resolveHold(held({ status: "cancelled" }), false, NOW)).toEqual({
      action: "skip",
      reason: "already-cancelled",
    });
  });
});

describe("secondsRemaining", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("counts down", () => {
    expect(secondsRemaining(new Date("2026-08-24T12:01:00.000Z"), now)).toBe(60);
    expect(secondsRemaining(new Date("2026-08-24T12:00:30.000Z"), now)).toBe(30);
  });

  it("never goes negative", () => {
    // A window that elapsed while the page was open reads as "any moment now",
    // not as a growing negative number.
    expect(secondsRemaining(new Date("2026-08-24T11:59:00.000Z"), now)).toBe(0);
  });

  it("rounds up, so one second left is not shown as zero", () => {
    expect(secondsRemaining(new Date("2026-08-24T12:00:00.400Z"), now)).toBe(1);
  });
});

describe("clampHoldWindow", () => {
  it("holds the range the database will accept", () => {
    expect(clampHoldWindow(5)).toBe(10);
    expect(clampHoldWindow(200_000)).toBe(86_400);
    expect(clampHoldWindow(90)).toBe(90);
  });

  it("falls back to the default rather than to zero", () => {
    // A zero-second hold is not a hold; it is autonomy with a misleading name.
    expect(clampHoldWindow(Number.NaN)).toBe(60);
    expect(clampHoldWindow(Infinity)).toBe(60);
  });
});
