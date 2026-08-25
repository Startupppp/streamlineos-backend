import { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD } from "../party/party-duplicates";
import type { FindingSeverity } from "../../db/schema/crm/data-quality";

/**
 * Turning a producer's continuous evidence into a group a person can decide about.
 *
 * The rule every producer obeys, and the reason these are pure functions rather
 * than expressions buried in a query: **`groupKey` must determine `severity`**.
 * The grouped view is one `GROUP BY`, and if severity varied inside a group it
 * would return the same shape of problem three times and ask a person the same
 * question at three severities. Putting the band inside the key is what makes
 * "412 findings, one decision" true.
 */

/**
 * Which signal is doing the work, strongest first.
 *
 * `party-duplicates`' own weighting read back out. A shared registration number
 * and a vaguely similar name are not the same finding, and a bulk merge is only
 * a defensible decision for the first.
 */
export const SIGNAL_STRENGTH = [
  "tax-number",
  "email",
  "phone",
  "website",
  "name-exact",
  "name-close",
  "name-similar",
  "email-domain",
] as const;

/**
 * The detector's own thresholds, read back out — no new numbers.
 *
 * `AUTO_MERGE_THRESHOLD` is already the bar for merging unattended, so a pair at
 * or above it is as certain as this system ever gets. The midpoint between it
 * and `REVIEW_THRESHOLD` splits what is left. Inventing a second set of bands
 * would let the queue and the detector disagree about the same pair.
 */
export function duplicateSeverity(score: number): FindingSeverity {
  if (score >= AUTO_MERGE_THRESHOLD) return "high";
  if (score >= (AUTO_MERGE_THRESHOLD + REVIEW_THRESHOLD) / 2) return "medium";
  return "low";
}

export function strongestSignal(signals: readonly string[]): string {
  return SIGNAL_STRENGTH.find((name) => signals.includes(name)) ?? "unknown";
}

/** Signal and band both, because they are two different decisions. */
export function duplicateGroupKey(signals: readonly string[], severity: FindingSeverity): string {
  return `duplicate:${strongestSignal(signals)}:${severity}`;
}

/**
 * Bands relative to the tenant's own threshold, never absolute day counts.
 *
 * A quarterly enterprise cycle and a weekly transactional one disagree about
 * what "quiet" means, and hard-coding ninety days would make this producer right
 * for one of them and noise for the other.
 */
export function stalenessBand(
  quietDays: number,
  thresholdDays: number,
): { band: string; severity: FindingSeverity } {
  if (quietDays >= thresholdDays * 3)
    return { band: `${thresholdDays * 3}d+`, severity: "high" };
  if (quietDays >= thresholdDays * 2)
    return { band: `${thresholdDays * 2}d+`, severity: "medium" };
  return { band: `${thresholdDays}d+`, severity: "low" };
}

export function stalenessGroupKey(band: string): string {
  return `staleness:${band}`;
}
