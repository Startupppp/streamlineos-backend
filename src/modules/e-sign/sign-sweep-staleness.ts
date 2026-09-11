/**
 * SIGN-P1-02, in-product half.
 *
 * `alert-sign-sweep-stale.mjs` is the platform alert and the primary
 * deliverable; this is the same judgement rendered on the admin screen, so an
 * operator learns a sweep has stopped from the product rather than only from
 * oncall. The two are separate implementations because a `.mjs` alert script
 * and the Nest runtime cannot share a module — so both are pinned by tests
 * covering the same four cases, and the window lives in one named constant on
 * each side.
 */

/**
 * 26 rather than 24: both sweeps are meant to run daily, and a window equal to
 * the period reports ordinary scheduling jitter as an outage.
 */
export const SWEEP_EXPECTED_WITHIN_HOURS = 26;

export type SweepStaleness = "ok" | "never_run" | "stale" | "errored";

/**
 * `never_run` is deliberately its own answer rather than folded into `stale`.
 * They call for different actions — one means the scheduler stopped, the other
 * that it was never pointed here — and it is the state SignOS was actually in.
 */
export function sweepStaleness(
  run: { ranAt: Date | string | null; error: string | null } | null,
  now: Date = new Date(),
  withinHours: number = SWEEP_EXPECTED_WITHIN_HOURS,
): SweepStaleness {
  if (!run || run.ranAt === null) return "never_run";
  if (run.error !== null) return "errored";
  const ranAtMs = run.ranAt instanceof Date ? run.ranAt.getTime() : new Date(run.ranAt).getTime();
  if (Number.isNaN(ranAtMs)) return "never_run";
  return now.getTime() - ranAtMs > withinHours * 3_600_000 ? "stale" : "ok";
}
