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

/** `lib/hold-class-stops.ts` `liveOutboundClassStops` — the live stops, projected. */
export const liveClassStopsResponseSchema = z.array(
  z.object({
    outboundClassStopId: z.string(),
    partyId: z.string(),
    outboundClass: z.string(),
    outboundMessageId: z.string().nullable(),
    reason: z.string().nullable(),
    stoppedByUserId: z.string().nullable(),
    stoppedAt: wireDate(),
  }),
);

/** `lib/hold-class-stops.ts` `releaseOutboundClassStop`; anything else throws. */
export const releaseClassStopResponseSchema = z.object({ released: z.literal(true) });

/**
 * `autonomy-repair.service.ts` `policiesFor`, which `setPolicy` also returns.
 *
 * `classes` is `effectiveRepairPolicy` spread over `REPAIR_CLASS_DEFINITIONS`,
 * so each entry carries the whole definition as well as the tenant's answer.
 */
export const repairPoliciesResponseSchema = z.object({
  autonomy: z.object({
    allowed: z.boolean(),
    decidedBy: z.enum(["platform-all", "platform-kind", "org-all", "org-kind", "default"]),
    reason: z.string().nullable(),
  }),
  classes: z.array(
    z.object({
      repairClass: z.string(),
      findingKind: z.string(),
      field: z.enum(["email", "phone"]),
      conservative: z.boolean(),
      reversibility: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      source: z.enum(["tenant", "default"]),
      reason: z.string().nullable(),
      effective: z.boolean(),
    }),
  ),
});

/** `autonomy-repair.service.ts` `runRepairs` — one `ClassOutcome` per class asked for. */
export const runRepairsResponseSchema = z.object({
  classes: z.array(
    z.object({
      repairClass: z.string(),
      considered: z.number().int(),
      repaired: z.number().int(),
      refused: z.number().int(),
      failed: z.number().int(),
      autonomousDecisionId: z.string().nullable(),
      outcome: z.enum(["applied", "skipped"]),
      explanation: z.string().nullable(),
    }),
  ),
  repaired: z.number().int(),
  leftForAPerson: z.number().int(),
});

/** `lib/repair-reads.ts` `listRepairsPage` — a cursor page of joined repair rows. */
export const listRepairsResponseSchema = cursorPageSchema(
  z.object({
    autonomyRepairId: z.string(),
    autonomousDecisionId: z.string(),
    repairClass: z.string(),
    findingId: z.string().nullable(),
    partyId: z.string(),
    field: z.string(),
    previousValue: z.string().nullable(),
    repairedValue: z.string().nullable(),
    appliedAt: wireDate(),
    revertedAt: nullableWireDate(),
    revertedByUserId: z.string().nullable(),
    revertedReason: z.string().nullable(),
    /** Left-joined from `business_parties`, so null when the party is gone. */
    partyName: z.string().nullable(),
  }),
);

/** `lib/repair-revert.ts` `revertOneRepair`; a refusal throws rather than returns. */
export const revertRepairResponseSchema = z.object({
  reverted: z.literal(true),
  partyId: z.string(),
  field: z.string(),
});

/** `lib/repair-reads.ts` `measureRepairLoop` — the loop against the human queue. */
export const repairMeasureResponseSchema = z.object({
  windowDays: z.number().int(),
  resolution: z.object({
    automated: z.number().int(),
    manual: z.number().int(),
    unattributed: z.number().int(),
    /** Null over an empty window: no evidence, not "no automation". */
    automatedShare: z.number().nullable(),
  }),
  repairs: z.object({
    byClass: z.array(
      z.object({
        repairClass: z.string(),
        applied: z.number().int(),
        reverted: z.number().int(),
      }),
    ),
    applied: z.number().int(),
    reverted: z.number().int(),
  }),
  remaining: z.object({
    total: z.number().int(),
    weighted: z.number(),
    byProducer: z.array(
      z.object({
        producer: z.string(),
        count: z.number().int(),
        weight: z.number(),
      }),
    ),
    oldestOpenAgeDays: z.number().int().nullable(),
  }),
});
