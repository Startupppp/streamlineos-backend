import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/** The page envelope both reads build by hand — reps and exemplars alike. */
const pageSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

/** `RepTrendPoint` — every bucket in the window, including the empty ones. */
const repTrendPointSchema = z.object({
  bucketStart: wireDate(),
  bucketEnd: wireDate(),
  calls: z.number().int(),
  medianTalkRatioBps: z.number().int().nullable(),
  medianQuestionRateBps: z.number().int().nullable(),
  nextStepCommittedBps: z.number().int().nullable(),
});

/** `RepCallAggregateRow` — one rep's window, with their name resolved for the page. */
const repCallAggregateRowSchema = z.object({
  repUserId: z.string(),
  callsAnalysed: z.number().int(),
  embargoed: z.number().int(),
  withoutSpeakerMetrics: z.number().int(),
  medianTalkRatioBps: z.number().int().nullable(),
  medianQuestionRateBps: z.number().int().nullable(),
  nextStepCommittedBps: z.number().int().nullable(),
  trend: z.array(repTrendPointSchema),
  /** Null for a rep who has left. */
  repName: z.string().nullable(),
});

export const repCallAggregatesResponseSchema = z.object({
  data: z.array(repCallAggregateRowSchema),
  pagination: pageSchema,
  meta: z.object({
    sinceDays: z.number().int(),
    since: wireDate(),
    bucket: z.enum(["day", "week"]),
    truncated: z.boolean(),
    scope: z.enum(["own", "team"]),
    unattributed: z.number().int(),
    embargoed: z.number().int(),
    consentBlocked: z.number().int(),
    privateWindowHours: z.number().int(),
  }),
});

/**
 * `CallExemplarRow` — a pointer and a measurement, never any of the call's text.
 *
 * The reader follows `activityId` to the analysis route, which applies the
 * visibility rule again on its own terms.
 */
const callExemplarRowSchema = z.object({
  activityId: z.string(),
  repUserId: z.string().nullable(),
  occurredAt: nullableWireDate(),
  analysedAt: wireDate(),
  talkRatioBps: z.number().int().nullable(),
  questionRateBps: z.number().int().nullable(),
  repTurnCount: z.number().int().nullable(),
  repQuestionCount: z.number().int().nullable(),
  nextStepCommitted: z.boolean(),
  /** The ranked value in the metric's own units. */
  metricValueBps: z.number().int().nullable(),
  /** Null for an unattributed call, and for a rep who has left. */
  repName: z.string().nullable(),
});

export const callExemplarsResponseSchema = z.object({
  data: z.array(callExemplarRowSchema),
  pagination: pageSchema,
  meta: z.object({
    metric: z.enum(["talk-ratio", "question-rate", "next-step"]),
    sinceDays: z.number().int(),
    since: wireDate(),
    truncated: z.boolean(),
    scope: z.enum(["own", "team"]),
    ineligible: z.number().int(),
    embargoed: z.number().int(),
    consentBlocked: z.number().int(),
    talkRatioTargetBps: z.number().int(),
    minimumRepTurns: z.number().int(),
    privateWindowHours: z.number().int(),
  }),
});
