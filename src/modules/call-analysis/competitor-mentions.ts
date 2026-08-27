/**
 * Which of the organisation's own competitors came up on a call.
 *
 * Deterministic, and matched against `crm_deal_competitors.competitor_key` —
 * the vocabulary the tenant already types on their deals. Asking a model "who
 * did they mention as an alternative" returns plausible names, and a plausible
 * name is exactly the failure that cannot be caught: nobody reviewing a
 * competitive-mentions report can tell a competitor they had not heard of from
 * one that does not exist. Matching a list the tenant wrote themselves has the
 * opposite failure — a competitor nobody has recorded is missed — which is
 * visible, fixable, and fixable in the place it belongs.
 */

/** Longest first, so "Acme Cloud" wins over "Acme" and is not counted twice. */
export function mentionedCompetitors(
  transcript: string,
  competitorKeys: readonly string[],
): string[] {
  const haystack = transcript.toLowerCase();
  const byLength = [...new Set(competitorKeys)]
    .map((key) => key.trim())
    .filter((key) => key.length >= 2)
    .sort((a, b) => b.length - a.length);

  const found: string[] = [];
  /**
   * Consumed as they match, so a shorter key contained in a longer one that
   * already matched does not report a second competitor. Without this, an
   * organisation tracking both "Acme" and "Acme Cloud" sees every mention of the
   * latter counted as two.
   */
  let remaining = haystack;

  for (const key of byLength) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(key.toLowerCase())}(?![\\p{L}\\p{N}])`, "gu");
    if (!pattern.test(remaining)) continue;
    found.push(key);
    remaining = remaining.replace(pattern, " ");
  }

  return found.sort((a, b) => a.localeCompare(b));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
