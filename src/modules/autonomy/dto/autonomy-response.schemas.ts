import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/** Full `autonomous_decisions` row returned by `listDecisions` cursor page items. */
export const autonomousDecisionSchema = z.object({
  autonomousDecisionId: z.string(),
  organizationId: z.string(),
  kind: z.string(),
  outcome: z.string(),
  triggerType: z.string(),
  triggerId: z.string().nullable(),
  partyId: z.string().nullable(),
  dealId: z.string().nullable(),
  activityId: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  confidence: z.number().nullable(),
  inputs: z.record(z.string(), z.unknown()).nullable(),
  decision: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string().nullable(),
  reversibility: z.string(),
  reversedAt: nullableWireDate(),
  reversedByUserId: z.string().nullable(),
  reversedReason: z.string().nullable(),
  decidedAt: wireDate(),
});

/** `autonomy-review.service.ts` `listDecisions` — `buildCursorPage` of decision rows. */
export const listDecisionsResponseSchema = cursorPageSchema(autonomousDecisionSchema);

/** `autonomy-corrections` row shape included in `getDecision`. */
const correctionSchema = z.object({
  autonomyCorrectionId: z.string(),
  organizationId: z.string(),
  autonomousDecisionId: z.string().nullable(),
  kind: z.string(),
  correctionType: z.string(),
  field: z.string(),
  systemValue: z.string().nullable(),
  humanValue: z.string().nullable(),
  reason: z.string().nullable(),
  correctedByUserId: z.string().nullable(),
  consented: z.boolean(),
  promotedAt: nullableWireDate(),
  createdAt: wireDate(),
});

/** `autonomy-review.service.ts` `getDecision` — full row + corrections. */
export const getDecisionResponseSchema = autonomousDecisionSchema.extend({
  corrections: z.array(correctionSchema),
});

/** `autonomy-reversal.service.ts` `reverseDecision`. */
export const reverseDecisionResponseSchema = z.object({
  reversed: z.literal(true),
  action: z.string(),
});

/** `autonomy-review.service.ts` `listSwitches` / `setSwitch`. */
export const listSwitchesResponseSchema = z.object({
  switches: z.array(
    z.object({
      organizationId: z.string().nullable(),
      kind: z.string(),
      enabled: z.boolean(),
      reason: z.string().nullable(),
      updatedAt: nullableWireDate(),
    }),
  ),
  effective: z.array(
    z.object({
      kind: z.string(),
      enabled: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});

/** `autonomy-scoring.service.ts` `scoreboard`. */
export const scoreboardResponseSchema = z.object({
  since: z.string(),
  days: z.number().int(),
  perKind: z.array(
    z.object({
      kind: z.string(),
      actions: z.number().int(),
      corrections: z.number().int(),
      correctionRate: z.number().nullable(),
      shadowScored: z.number().int(),
      shadowDisagreed: z.number().int(),
      shadowDisagreementRate: z.number().nullable(),
    }),
  ),
  dataset: z.object({
    windowDays: z.number().int(),
    current: z.object({
      composite: z.number(),
      openTotal: z.number().int(),
      bySeverity: z.object({ high: z.number().int(), medium: z.number().int(), low: z.number().int() }),
      byClass: z.array(
        z.object({
          producer: z.string(),
          count: z.number().int(),
          weight: z.number(),
        }),
      ),
    }),
    series: z.array(
      z.object({
        capturedOn: z.string(),
        composite: z.number(),
        openTotal: z.number().int(),
      }),
    ),
    baseline: z
      .object({
        capturedOn: z.string(),
        composite: z.number(),
        openTotal: z.number().int(),
      })
      .nullable(),
    delta: z.number().nullable(),
    direction: z.enum(["improving", "worsening", "unchanged"]).nullable(),
  }),
  spend: z.object({
    calls: z.number().int(),
    totalTokens: z.number().int(),
    estimatedCostUsd: z.string(),
  }),
});

/** `autonomy-scoring.service.ts` `reviewQueue` — projected join rows. */
export const reviewQueueResponseSchema = z.array(
  z.object({
    autonomyShadowScoreId: z.string(),
    autonomousDecisionId: z.string(),
    kind: z.string(),
    verdict: z.string(),
    score: z.number().nullable(),
    rationale: z.string().nullable(),
    createdAt: wireDate(),
    decisionSummary: z.string().nullable(),
    decidedAt: wireDate(),
    confidence: z.number().nullable(),
  }),
);

/** `autonomy-scoring.service.ts` `markReviewed`. */
export const markReviewedResponseSchema = z.object({ reviewed: z.boolean() });

/** `autonomy-hold.service.ts` `liveHolds`. */
export const liveHoldsResponseSchema = z.array(
  z.object({
    autonomyHoldId: z.string(),
    autonomousDecisionId: z.string(),
    quoteId: z.number().int().nullable(),
    holdUntil: wireDate(),
    createdAt: wireDate(),
    quoteSubject: z.string().nullable(),
    summary: z.string().nullable(),
    secondsRemaining: z.number(),
  }),
);

/** `autonomy-hold.service.ts` `cancelHold`. */
export const cancelHoldResponseSchema = z.object({ cancelled: z.literal(true) });

/** `autonomy-settings.service.ts` `settingsFor` / `updateSettings`. */
export const autonomySettingsResponseSchema = z.object({
  shadowSampleRate: z.number(),
  shadowDailyCap: z.number().int(),
  holdWindowSeconds: z.number().int(),
  autoQuoteEnabled: z.boolean(),
});
