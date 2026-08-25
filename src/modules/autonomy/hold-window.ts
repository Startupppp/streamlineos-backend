import type { HoldStatus } from "../../db/schema/crm/autonomy-holds";

/**
 * What happens when a hold's window runs out.
 *
 * Pure, because every branch here is a thing that must never happen twice, and
 * the ones worth testing are the races.
 */

export interface HoldState {
  readonly status: HoldStatus;
  readonly holdUntil: Date;
}

export type HoldResolution =
  | { readonly action: "send" }
  | {
      readonly action: "skip";
      readonly reason: "already-cancelled" | "already-sent" | "failed" | "not-yet-due";
    }
  | { readonly action: "cancel"; readonly reason: "switched-off" };

/**
 * How early a wake still counts as due.
 *
 * The runtime claims a sleeping run on `run_after <= now()` — the *database*
 * clock — while `hold_until` and the `now` passed here are both the *application*
 * clock. A database running milliseconds ahead therefore hands back a run that
 * is fractionally early by the caller’s reckoning, and refusing to send it would
 * strand the hold at `held` forever with nothing left to re-drive it.
 *
 * Two seconds absorbs that and nothing else: `clampHoldWindow` floors a window
 * at ten, so this can never swallow a whole one, and the failure this guard is
 * actually for — a run woken long before its window ran out — is orders of
 * magnitude larger.
 */
const DUE_TOLERANCE_MS = 2_000;

/**
 * Whether the wait is over and what to do about it.
 *
 * The kill switch is re-read on wake, not just when the hold was created. A hold
 * placed at nine in the morning and an operator killing quote sending at noon
 * must not still send at one — otherwise the switch stops new holds and lets the
 * dangerous, already-decided ones through, which is the wrong way round.
 *
 * The window is then checked against `now` rather than trusted to the runtime.
 * The runtime does enforce it — `step.sleep` sets `run_after` and the claim gates
 * on it — but a hold is the one thing here that cannot be undone once it acts,
 * and "the scheduler would never wake this early" is not a property this file can
 * see. Checked last, so a switch that went off still cancels a hold whose window
 * has not run out rather than leaving it to expire.
 */
export function resolveHold(
  state: HoldState,
  switchAllows: boolean,
  now: Date = new Date(),
): HoldResolution {
  if (state.status === "cancelled") return { action: "skip", reason: "already-cancelled" };
  if (state.status === "sent") return { action: "skip", reason: "already-sent" };
  if (state.status === "failed") return { action: "skip", reason: "failed" };

  if (!switchAllows) return { action: "cancel", reason: "switched-off" };

  if (now.getTime() < state.holdUntil.getTime() - DUE_TOLERANCE_MS)
    return { action: "skip", reason: "not-yet-due" };

  return { action: "send" };
}

/**
 * Seconds left, for the countdown in the review feed.
 *
 * Never negative: a window that elapsed while the page was open reads as "any
 * moment now" rather than as a growing negative number, and the send is decided
 * by the workflow rather than by what the browser believes the time is.
 */
export function secondsRemaining(holdUntil: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((holdUntil.getTime() - now.getTime()) / 1000));
}

/** Clamp a configured window into the range the database will accept. */
export function clampHoldWindow(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60;
  return Math.min(86_400, Math.max(10, Math.floor(seconds)));
}
