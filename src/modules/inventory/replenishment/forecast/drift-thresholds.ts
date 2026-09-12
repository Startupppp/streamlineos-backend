/**
 * C7 — the two rules that decide whether a stored forecast needs a human.
 *
 * Pure, and separate from the service, because both are judgements rather than
 * queries and a judgement that can only be exercised against a seeded database
 * is a judgement nobody checks.
 */

/**
 * A ratio of 1 means the average forecast error is the size of an average
 * week's demand — a forecast no better than guessing the mean.
 *
 * Relative rather than absolute on purpose. An MAE of 40 is a catastrophe on a
 * SKU selling five a week and noise on one selling five thousand, so a single
 * absolute threshold across a catalogue either alerts on everything or on
 * nothing.
 */
export const DEFAULT_MAE_RATIO_THRESHOLD = 1;

/**
 * Whether this version's error has crossed the line.
 *
 * A null ratio is *not* a breach. It means the SKU sold nothing over the window
 * or the champion had no metrics, and reporting "no demand" as "badly forecast"
 * fills the watchlist with items nobody can act on — which is how a monitor
 * gets ignored, and then the real drift goes unnoticed too.
 */
export function breachesMaeThreshold(
  maeRatio: string | null,
  threshold: number,
): boolean {
  if (maeRatio === null) return false;
  const ratio = Number(maeRatio);
  if (!Number.isFinite(ratio)) return false;
  return ratio >= threshold;
}

/**
 * The staleness policy: a version is stale once it has outlived the horizon it
 * claims to speak for.
 *
 * Derived from the version's own `horizonWeeks` rather than from a global
 * setting, because a four-week forecast and a twenty-six-week forecast go out
 * of date at very different speeds and one number for both would be wrong for
 * at least one of them.
 */
export function isStaleVersion(
  generatedAt: Date | string,
  horizonWeeks: number,
  now: Date = new Date(),
): boolean {
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) return false;
  const horizonMs = Math.max(horizonWeeks, 0) * 7 * 86_400_000;
  return now.getTime() > generated.getTime() + horizonMs;
}

/** Whole days since the version was generated, floored, never negative. */
export function ageInDays(generatedAt: Date | string, now: Date = new Date()): number {
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - generated.getTime()) / 86_400_000));
}
