/**
 * What counts as a touch, and the order touches are counted in.
 *
 * The premise of this module is that the timeline already holds every touch —
 * `crm_lead_touchpoints` holds what marketing did to a lead, `activities` holds
 * what sales did to the deal — and that the only thing missing was a way to
 * divide one deal's value across them. So this file defines the *shape* both
 * sources are read into, and nothing else: no database, no channel taxonomy of
 * its own, no model.
 *
 * It is separate from the models because the models must never see a row. A
 * weighting rule that takes a Drizzle row can only be tested by inserting one,
 * and the whole point of the split is that the arithmetic dividing revenue is
 * provable at a desk.
 */

/** Which table a touch came out of. Kept on the row so a reader can go look. */
export const TOUCH_KINDS = ["touchpoint", "activity"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export interface AttributionTouch {
  /**
   * Unique within a touch set, and stable across recomputation.
   *
   * Namespaced by source (`touchpoint:…`, `activity:…`) because the two tables
   * generate ids independently — a UUID from one and a UUID from the other can
   * collide only by accident, but `lead_id` style integers cannot be told apart
   * at all. A collision here would silently merge two touches into one and the
   * total would still sum correctly, which is the worst kind of wrong.
   */
  readonly touchKey: string;
  readonly touchKind: TouchKind;
  /** Lower-cased, whitespace-collapsed. Roll-ups group on this string. */
  readonly channel: string;
  /** Null when the touch is not campaign-bound; every sales activity is. */
  readonly campaignId: number | null;
  readonly occurredAt: Date;
  /** `first_touch`, `interaction`, `call`, `email`… — display only. */
  readonly detail: string | null;
}

export function makeTouchKey(kind: TouchKind, id: string | number): string {
  return `${kind}:${id}`;
}

/**
 * One channel spelling, whatever the writer typed.
 *
 * `Email`, `email ` and `EMAIL` are one channel to everybody except a GROUP BY,
 * and a roll-up that reports them as three lines is worse than no roll-up: it
 * understates each of them and nobody can see that it has. The touchpoint
 * columns this reads are free text written by four different call sites
 * (`leads.service.ts` defaults `source` to the string `direct`), so normalising
 * at the read is the only place it can be done once.
 *
 * The fallback is a named string rather than null so that unattributable spend
 * stays visible in the roll-up instead of vanishing into a null group.
 */
export function normaliseChannel(
  raw: string | null | undefined,
  fallback = "unknown",
): string {
  const trimmed = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Chronological, with a tie-break that is a real one.
 *
 * `occurred_at` alone is not a total order — a lead import writes hundreds of
 * touchpoints in the same millisecond — and every model here depends on the
 * order: first-touch and last-touch read the ends of it, position-based reads
 * both ends and the middle. Sorted on time alone, "which touch was first" would
 * be decided by whatever order the planner returned rows in, so the same deal
 * could attribute its value to a different campaign on a second read with no
 * data having changed. The touch key breaks the tie because it is unique and
 * stable; it is not meaningful, and it does not need to be.
 *
 * Returns a new array. Sorting the caller's array in place would reorder a touch
 * set that a caller is about to run a second model over, and the second answer
 * would depend on the first having been computed.
 */
export function orderTouches(
  touches: readonly AttributionTouch[],
): AttributionTouch[] {
  return [...touches].sort((a, b) => {
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return a.touchKey < b.touchKey ? -1 : a.touchKey > b.touchKey ? 1 : 0;
  });
}

/**
 * The touches that can be credited for a deal closed at `asOf`.
 *
 * A touch after the close cannot have contributed to it. This is not a
 * fastidiousness: activities keep being logged against a won deal — the
 * onboarding call, the invoice chase — and counting them would move credit from
 * the campaign that created the deal to whoever handled it afterwards, which is
 * exactly the misattribution the module exists to end.
 */
export function touchesUpTo(
  touches: readonly AttributionTouch[],
  asOf: Date,
): AttributionTouch[] {
  const cutoff = asOf.getTime();
  return touches.filter((touch) => touch.occurredAt.getTime() <= cutoff);
}
