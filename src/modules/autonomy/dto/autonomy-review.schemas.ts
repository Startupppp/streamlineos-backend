import { z } from "zod";
import { DECISION_KINDS, DECISION_OUTCOMES } from "../../../db/schema/crm/autonomous-decisions";
import { queryBoolean } from "../../../common/validation/query-boolean";

/**
 * Filing a communication is deterministic and effectively always right, so one
 * entry per inbound message would bury the judgements that actually need
 * review. The rows are still written — the audit trail is meant to be complete
 * rather than interesting, and the correction rate needs the denominator — but
 * the feed hides them unless asked.
 */
export const ROUTINE_KINDS = ["activity.logged"] as const;

export const listDecisionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),

    kind: z.enum(DECISION_KINDS).optional(),
    outcome: z.enum(DECISION_OUTCOMES).optional(),
    partyId: z.string().min(1).max(64).optional(),
    dealId: z.string().min(1).max(64).optional(),
    /** The rep whose deals these decisions touched. */
    assignedToId: z.string().min(1).max(64).optional(),
    /** Only what a human took back, which is a manager's first question. */
    reversedOnly: queryBoolean.optional(),
    /** Include the routine filing entries the default view hides. */
    includeRoutine: queryBoolean.default(false),
  })
  .strict();

export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;

export const reverseDecisionSchema = z
  .object({
    /**
     * Why, in the reviewer's words. Optional, because requiring a justification
     * on a one-click undo is how the undo stops being used — and an unexplained
     * reversal is still a far better record than a silent database edit.
     */
    reason: z.string().trim().min(1).max(500).optional(),
    /**
     * Whether this correction may be used to improve the model. Defaults to
     * false: only consented or synthetic data may enter an evaluation dataset,
     * so the safe default is the one that keeps it out.
     */
    consented: z.boolean().default(false),
  })
  .strict();

export type ReverseDecisionInput = z.infer<typeof reverseDecisionSchema>;

export const setSwitchSchema = z
  .object({
    /** `*` turns every action type off at once. */
    kind: z.enum(["*", ...DECISION_KINDS]),
    enabled: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type SetSwitchInput = z.infer<typeof setSwitchSchema>;

export const scoreboardQuerySchema = z
  .object({
    /** Window in days. Capped so a scoreboard cannot become a full-table scan. */
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();

export type ScoreboardQuery = z.infer<typeof scoreboardQuerySchema>;

export const reviewQueueQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

export const updateAutonomySettingsSchema = z
  .object({
    /**
     * Bounded here as well as in the database. The CHECK is the last line; a
     * caller deserves a 400 that names the field rather than a 500 from a
     * constraint they cannot see.
     */
    shadowSampleRate: z.number().min(0).max(1).optional(),
    shadowDailyCap: z.number().int().min(0).max(100_000).optional(),
    /**
     * A zero-second hold is not a hold, it is autonomy with a misleading name.
     * The ceiling stops a "hold" nobody will see expire, which would quietly
     * become the approval queue this product exists to remove.
     */
    holdWindowSeconds: z.number().int().min(10).max(86_400).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });

export type UpdateAutonomySettingsInput = z.infer<typeof updateAutonomySettingsSchema>;
