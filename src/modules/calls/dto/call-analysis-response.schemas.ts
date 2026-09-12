import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/** `CallAnalysis` from `call-analysis.service.ts` — the stored row as a caller reads it. */
const callAnalysisSchema = z.object({
  activityId: z.string(),
  transcriptHash: z.string(),
  analyzerVersion: z.number().int(),
  /** Basis points of 10000. Null when the transcript is not speaker-attributed. */
  talkRatioBps: z.number().int().nullable(),
  questionRateBps: z.number().int().nullable(),
  repTurnCount: z.number().int().nullable(),
  repQuestionCount: z.number().int().nullable(),
  objections: z.array(
    z.object({
      quote: z.string(),
      handling: z.enum(["answered", "acknowledged", "deflected", "unaddressed"]),
      /** Null exactly when nobody answered. */
      response: z.string().nullable(),
    }),
  ),
  competitorMentions: z.array(z.object({ name: z.string(), quote: z.string() })),
  nextStepCommitted: z.boolean(),
  nextStep: z.string().nullable(),
  model: z.string().nullable(),
  transcriptChars: z.number().int(),
  analysedAt: wireDate(),
});

/**
 * What both read paths return — `withVisibility` in the controller.
 *
 * `data` is null while the rep's private window is still open, which is why it
 * is nullable rather than the route refusing: "not yet, here is when" is the
 * only answer that describes what is happening, and neither a 403 nor a 404 can
 * carry `opensAt`.
 */
export const callAnalysisResponseSchema = z.object({
  data: callAnalysisSchema.nullable(),
  cached: z.boolean(),
  visibility: z.object({
    visible: z.boolean(),
    reason: z.enum([
      "own-call",
      "released",
      "window-elapsed",
      "unattributed",
      "rep-window",
      "not-your-call",
    ]),
    opensAt: nullableWireDate(),
    privateWindowHours: z.number().int(),
  }),
});

/** The rep's release. A refusal throws, so only the success shape is returned. */
export const callAnalysisReleaseResponseSchema = z.object({
  data: z.object({
    activityId: z.string(),
    analyzerVersion: z.number().int(),
    releasedAt: wireDate(),
    alreadyReleased: z.boolean(),
  }),
});

/** One band of the digest's distribution. Never keyed by person — see the controller. */
const coachingBandSchema = z.object({
  label: z.string(),
  calls: z.number().int(),
});

/**
 * `CoachingDigest`, with the thresholds it depends on beside it.
 *
 * Every metric is nullable together: below `COACHING_MIN_COHORT` the digest is
 * suppressed and returns its shape with the numbers absent, which is the answer
 * rather than a failure.
 */
export const coachingDigestResponseSchema = z.object({
  data: z.object({
    cohort: z.number().int(),
    embargoed: z.number().int(),
    suppressed: z.boolean(),
    withoutSpeakerMetrics: z.number().int(),
    talkRatio: z.array(coachingBandSchema).nullable(),
    questionRate: z.array(coachingBandSchema).nullable(),
    objectionHandling: z
      .object({
        answered: z.number().int(),
        acknowledged: z.number().int(),
        deflected: z.number().int(),
        unaddressed: z.number().int(),
      })
      .nullable(),
    competitors: z.array(z.object({ name: z.string(), calls: z.number().int() })).nullable(),
    nextStepCommittedBps: z.number().int().nullable(),
  }),
  meta: z.object({
    sinceDays: z.number().int(),
    since: wireDate(),
    truncated: z.boolean(),
    minimumCohort: z.number().int(),
    privateWindowHours: z.number().int(),
  }),
});
