import {
  advanceWatermark,
  FAILURE_LIMIT,
  INITIAL_LOOKBACK_MS,
  OVERLAP_MS,
  planSweep,
  type MailboxSyncState,
} from "./mailbox-sync";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const state = (over: Partial<MailboxSyncState> = {}): MailboxSyncState => ({
  syncedThrough: null,
  enabled: true,
  consecutiveFailures: 0,
  ...over,
});

describe("planSweep", () => {
  it("reads a week back on a mailbox that has never synced", () => {
    // Enough to be useful, not enough to import somebody's decade.
    const plan = planSweep(state(), NOW);
    expect(plan).toMatchObject({ sweep: true, firstRun: true });
    if (plan.sweep) expect(plan.since.getTime()).toBe(NOW.getTime() - INITIAL_LOOKBACK_MS);
  });

  /**
   * The rule that stops messages disappearing. One arriving while a sweep runs
   * has a timestamp before the watermark that sweep is about to write, so with
   * no overlap it falls in the gap and is never read again.
   */
  it("overlaps the previous watermark", () => {
    const syncedThrough = new Date("2026-08-25T11:00:00.000Z");
    const plan = planSweep(state({ syncedThrough }), NOW);
    if (!plan.sweep) throw new Error("expected a sweep");
    expect(plan.since.getTime()).toBe(syncedThrough.getTime() - OVERLAP_MS);
    expect(plan.firstRun).toBe(false);
  });

  it("does not sweep a mailbox somebody switched off", () => {
    expect(planSweep(state({ enabled: false }), NOW)).toEqual({ sweep: false, reason: "disabled" });
  });

  /**
   * A mailbox that has failed ten times running has been revoked or had its
   * scope removed. Continuing spends a provider quota every few minutes forever
   * and buries the mailboxes that are merely slow.
   */
  it("gives up on one that keeps failing", () => {
    expect(planSweep(state({ consecutiveFailures: FAILURE_LIMIT }), NOW)).toEqual({
      sweep: false,
      reason: "too-many-failures",
    });
    expect(planSweep(state({ consecutiveFailures: FAILURE_LIMIT - 1 }), NOW).sweep).toBe(true);
  });
});

describe("advanceWatermark", () => {
  const earlier = new Date("2026-08-25T10:00:00.000Z");
  const later = new Date("2026-08-25T11:00:00.000Z");

  it("moves forward to the newest message actually read", () => {
    expect(advanceWatermark(earlier, later)).toBe(later);
  });

  /**
   * Never backwards. A sweep that read only older mail than a previous one has
   * not undone that previous one's progress.
   *
   * The other half of the rule — never past what was read — cannot be violated
   * by this function at all: it can only return one of the two dates it was
   * given. It is violated by what a caller passes as `newestSeen`, which is why
   * naming it here gave the coverage away for free exactly where the risk lives.
   * `crm-mailbox.service.spec.ts` holds it against the caller instead: a
   * truncated page must not hand over a newest, and an estimated timestamp must
   * not either.
   */
  it("never moves backwards", () => {
    expect(advanceWatermark(later, earlier)).toBe(later);
  });

  it("stays put when a sweep found nothing", () => {
    // An empty sweep is not evidence that time has passed for the provider.
    expect(advanceWatermark(later, null)).toBe(later);
    expect(advanceWatermark(null, null)).toBeNull();
  });

  it("takes the first watermark from the first message read", () => {
    expect(advanceWatermark(null, earlier)).toBe(earlier);
  });
});
