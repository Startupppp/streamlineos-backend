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
  | { readonly action: "skip"; readonly reason: "already-cancelled" | "already-sent" | "failed" }
  | { readonly action: "cancel"; readonly reason: "switched-off" };

/**
 * Whether the wait is over and what to do about it.
 *
 * The kill switch is re-read on wake, not just when the hold was created. A hold
 * placed at nine in the morning and an operator killing quote sending at noon
 * must not still send at one — otherwise the switch stops new holds and lets the
 * dangerous, already-decided ones through, which is the wrong way round.
 */
export function resolveHold(state: HoldState, switchAllows: boolean): HoldResolution {
  if (state.status === "cancelled") return { action: "skip", reason: "already-cancelled" };
  if (state.status === "sent") return { action: "skip", reason: "already-sent" };
  if (state.status === "failed") return { action: "skip", reason: "failed" };

  if (!switchAllows) return { action: "cancel", reason: "switched-off" };

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
