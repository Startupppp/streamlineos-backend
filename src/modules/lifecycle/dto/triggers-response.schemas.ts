import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * What a renewal sweep did, and the log of every firing.
 *
 * The entries are the accountable half: a stand-down and a refusal are both
 * normal answers, which is why `outcome` and `reason` are nullable rather than
 * the sweep throwing on anything it declined to act on.
 */

/** `SweepEntry` — one candidate's decision. */
const sweepEntrySchema = z.object({
  customerLifecycleId: z.string(),
  partyId: z.string(),
  renewalOn: z.string(),
  action: z.enum(["opened", "reoffered", "stood-down"]),
  /** Set only when the outbound loop was actually asked. */
  outcome: z.enum(["held", "skipped"]).nullable(),
  /** The stand-down reason, or the loop's own refusal sentence. */
  reason: z.string().nullable(),
  triggerId: z.string().nullable(),
  opportunityDealId: z.number().int().nullable(),
  autonomyHoldId: z.string().nullable(),
});

export const sweepLifecycleTriggersResponseSchema = z.object({
  asOf: wireDate(),
  considered: z.number().int(),
  opened: z.number().int(),
  reoffered: z.number().int(),
  held: z.number().int(),
  entries: z.array(sweepEntrySchema),
});

/** `consider` — the same decision for one contract, so the same entry. */
export const considerLifecycleTriggerResponseSchema = sweepEntrySchema;

/** `list` — the trigger log, newest first, with the party name joined in. */
export const listLifecycleTriggersResponseSchema = z.object({
  triggers: z.array(
    z.object({
      customerLifecycleTriggerId: z.string(),
      customerLifecycleId: z.string(),
      partyId: z.string(),
      /** Null when the party record has gone; the firing still happened. */
      partyName: z.string().nullable(),
      kind: z.string(),
      termStartedOn: z.string(),
      renewalOn: z.string(),
      dueOn: z.string(),
      riskScore: z.number().int(),
      /** Null for "the health model could not say". */
      healthScore: z.number().int().nullable(),
      opportunityDealId: z.number().int().nullable(),
      attempts: z.number().int(),
      lastAttemptAt: nullableWireDate(),
      outcome: z.string().nullable(),
      /** Null exactly when the loop did not stop. */
      refusalStage: z.string().nullable(),
      refusalReason: z.string().nullable(),
      autonomyHoldId: z.string().nullable(),
      autonomousDecisionId: z.string().nullable(),
      outboundMessageId: z.string().nullable(),
      firedAt: wireDate(),
    }),
  ),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});
