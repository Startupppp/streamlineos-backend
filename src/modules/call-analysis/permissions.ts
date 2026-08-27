/**
 * The two keys ticket 02's fourth criterion gates on.
 *
 * Two rather than one, and the split is the ticket rather than tidiness. Seeing
 * your own calls is something every seller should have from the day they are
 * hired; seeing the team pooled is a manager's. One key would mean granting a
 * rep the team surface in order to give them their own, which is exactly the
 * shape the ticket says people route around.
 *
 * Named here rather than inline in the controller so the migration test can
 * check that `0533` backfills these exact strings. A backfill and a decorator
 * that disagree about a key is a silent 403 for every organisation that existed
 * before the migration — see `backfill-slugs-exist.spec.ts` for the seven times
 * that has already happened in this series.
 */

/** A seller's own calls, their own trend, and the prompts about themselves. */
export const CALL_ANALYSIS_VIEW_OWN = "crm:call-analysis:view-own";

/** The pooled team surface. Carries no individual call and no individual person. */
export const CALL_ANALYSIS_VIEW_TEAM = "crm:call-analysis:view-team";

export const CALL_ANALYSIS_PERMISSIONS = [
  CALL_ANALYSIS_VIEW_OWN,
  CALL_ANALYSIS_VIEW_TEAM,
] as const;
