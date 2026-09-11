import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * The decision as `wire()` in the controller flattens it.
 *
 * `reason` and `note` are null exactly when the call is allowed: there is
 * nothing to explain, and carrying a stale refusal forward would be worse than
 * carrying nothing.
 */
const callConsentDecisionSchema = z.object({
  activityId: z.string(),
  allowed: z.boolean(),
  regime: z.enum(["one-party", "two-party"]),
  jurisdiction: z.string().nullable(),
  /** The citation behind the regime. Null when it defaulted. */
  basis: z.string().nullable(),
  ruleVersion: z.number().int(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
});

/** Both `read` and `attest` answer with the decision, so a refusal is never silent. */
export const callRecordingConsentResponseSchema = z.object({
  data: callConsentDecisionSchema,
});

/**
 * The refusal ledger — `RefusalLedgerRow` with its reason spelled out.
 *
 * It carries no transcript, no quote and no analysis: the refusal exists
 * precisely because none of that may be produced.
 */
export const consentRefusalsResponseSchema = z.object({
  data: z.array(
    z.object({
      activityId: z.string(),
      jurisdiction: z.string().nullable(),
      reason: z.string(),
      note: z.string(),
      ruleVersion: z.number().int(),
      attempts: z.number().int(),
      firstRefusedAt: wireDate(),
      lastRefusedAt: wireDate(),
      summary: z.string(),
    }),
  ),
  meta: z.object({
    sinceDays: z.number().int(),
    ruleVersion: z.number().int(),
    defaultRegime: z.string(),
  }),
});
