import { z } from "zod";

/**
 * The only input either route takes.
 *
 * Bounded rather than left as free text because the value goes into a `text =`
 * predicate against a tenant-scoped table: the bound costs nothing and keeps an
 * unbounded string out of the query plan.
 */
export const callAnalysisParamsSchema = z.object({
  activityId: z.string().trim().min(1).max(64),
});

export type CallAnalysisParams = z.infer<typeof callAnalysisParamsSchema>;

/**
 * What a rep may say when they share their own analysis early.
 *
 * A note rather than a bare switch, because the release is meant to be an act of
 * communication — "the pricing objection near the end is the one I want help
 * with" — and a share control with nowhere to put that is the surveillance
 * reading of the same feature. Bounded at 500 so it stays a sentence: this is
 * not a comment thread, and an unbounded field here would become one without
 * anybody deciding it should.
 */
export const callAnalysisReleaseBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export type CallAnalysisReleaseBody = z.infer<typeof callAnalysisReleaseBodySchema>;

/**
 * The period a coaching digest covers.
 *
 * Defaulted rather than required, because a manager opening the page has not
 * chosen a period and a 400 would be a worse first impression than a sensible
 * month. Capped at 90 days for a reason that is not arithmetic: the digest reads
 * rows and applies the visibility rule in process (see `call-coaching.service`),
 * so an unbounded period is an unbounded read, and `COACHING_MAX_ROWS` would
 * then truncate silently on every request from a busy team.
 */
export const coachingDigestQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(90).default(30),
});

export type CoachingDigestQuery = z.infer<typeof coachingDigestQuerySchema>;
