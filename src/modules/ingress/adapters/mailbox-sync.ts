/**
 * Deciding what a mailbox sweep should ask the provider for.
 *
 * Pure, because the interesting parts are the boundaries: how far back to read
 * when a mailbox has never synced, how much to overlap so a message that
 * arrived mid-sweep is not missed, and when to stop trying a mailbox that keeps
 * failing.
 */

/** First sync. Enough to be useful, not enough to import somebody's decade. */
export const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deliberate overlap on every sweep.
 *
 * A message that arrives while a sweep is running has a timestamp before the
 * watermark the sweep is about to write, so without overlap it falls in the gap
 * and is never read again. Re-offering a few minutes of messages costs nothing
 * because the seam deduplicates on the provider's own id.
 */
export const OVERLAP_MS = 5 * 60 * 1000;

/** After this many consecutive failures a mailbox stops being swept. */
export const FAILURE_LIMIT = 10;

export interface MailboxSyncState {
  readonly syncedThrough: Date | null;
  readonly enabled: boolean;
  readonly consecutiveFailures: number;
}

export type SweepPlan =
  | { readonly sweep: false; readonly reason: "disabled" | "too-many-failures" }
  | { readonly sweep: true; readonly since: Date; readonly firstRun: boolean };

export function planSweep(state: MailboxSyncState, now: Date = new Date()): SweepPlan {
  if (!state.enabled) return { sweep: false, reason: "disabled" };

  /**
   * A mailbox that has failed ten times in a row is not going to succeed on the
   * eleventh; it has been revoked, or the scope was removed. Continuing would
   * spend a provider quota every few minutes forever and bury the mailboxes
   * that are merely slow.
   */
  if (state.consecutiveFailures >= FAILURE_LIMIT)
    return { sweep: false, reason: "too-many-failures" };

  if (!state.syncedThrough)
    return { sweep: true, since: new Date(now.getTime() - INITIAL_LOOKBACK_MS), firstRun: true };

  return {
    sweep: true,
    since: new Date(state.syncedThrough.getTime() - OVERLAP_MS),
    firstRun: false,
  };
}

/**
 * How far the watermark may advance after a sweep.
 *
 * Never past the newest message actually read. Advancing to "now" would claim
 * everything up to this instant had been seen, and anything the provider had
 * not yet indexed would be skipped permanently — the gap this whole mechanism
 * exists to close.
 */
export function advanceWatermark(
  current: Date | null,
  newestSeen: Date | null,
): Date | null {
  if (!newestSeen) return current;
  if (!current) return newestSeen;
  return newestSeen > current ? newestSeen : current;
}
