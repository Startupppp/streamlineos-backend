import { z } from "zod";
import {
  ISSUE_RECORD_TYPES,
  ISSUE_SEVERITIES,
  ISSUE_STAGES,
} from "../../../db/schema/crm/issue-records";
import { queryBoolean } from "../../../common/validation/query-boolean";

/**
 * The boundary of the three record types.
 *
 * Two decisions here are worth the words; the rest is ordinary bounding.
 *
 * `stage` appears in no create or update schema. A stage only moves through the
 * transition ledger, and accepting it on a record write would be a second,
 * unaccountable path that leaves no row saying who moved it — which is the whole
 * failure the ledger exists to close. The renderer agrees by construction: the
 * field is `readOnly`, so the generated form never offers it.
 *
 * `recordType` appears in no update schema either. A task is not a complaint
 * with a different word on it: a complaint is required to anchor to a Party, so
 * turning one into the other either invents a party or violates the CHECK. A
 * record filed as the wrong type is closed and re-raised, which is also the
 * honest audit trail.
 */

/** The platform's list cap. A page larger than this is a report, not a list. */
export const MAX_PAGE = 400;

const identifier = z.string().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);

export const listIssuesQuerySchema = z
  .object({
    /**
     * Required, not optional. A list has to know which record type it is showing
     * before it can be shown at all — the layout, the columns and the words on
     * the empty state are all properties of the type. A mixed list would need a
     * layout that describes none of them.
     */
    recordType: z.enum(ISSUE_RECORD_TYPES),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
    cursor: z.string().min(1).max(512).optional(),

    stage: z.enum(ISSUE_STAGES).optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    ownerUserId: identifier.optional(),
    partyId: identifier.optional(),
    dealId: z.coerce.number().int().positive().optional(),
    /** Work that is still somebody's problem, which is the daily question. */
    openOnly: queryBoolean.optional(),
    /** Past its clock. Meaningless on a closed record, so it implies `openOnly`. */
    overdueOnly: queryBoolean.optional(),
    /**
     * Oldest first by default, matching the data-quality queue. A newest-first
     * list of open work is a list where the oldest failure is never seen again.
     */
    order: z.enum(["oldest", "newest"]).default("oldest"),
  })
  .strict();
export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;

export const createIssueSchema = z
  .object({
    recordType: z.enum(ISSUE_RECORD_TYPES),
    title: text(200),
    severity: z.enum(ISSUE_SEVERITIES),
    details: z.string().trim().max(8000).optional(),
    reference: text(80).optional(),
    ownerUserId: identifier.optional(),
    partyId: identifier.optional(),
    dealId: z.number().int().positive().optional(),
    dueAt: z.string().datetime().optional(),
  })
  .strict()
  /**
   * Criterion 2, stated at the boundary as well as in the CHECK. A 400 naming
   * the missing party is a better answer than a 23514 from Postgres, and the
   * CHECK stays because a writer that never passes through this schema — a
   * migration, a future importer — must be refused too.
   */
  .refine((body) => body.recordType !== "complaint" || body.partyId !== undefined, {
    message: "A complaint must anchor to a party",
    path: ["partyId"],
  })
  /**
   * A deal anchor with no party is a commercial link to nobody. The deal already
   * names its own party; a record claiming one and not the other is a record
   * whose two anchors can disagree.
   */
  .refine((body) => body.dealId === undefined || body.partyId !== undefined, {
    message: "A deal anchor needs the party it concerns",
    path: ["partyId"],
  });
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

/**
 * Nullable where the create schema is merely optional: clearing an owner, a due
 * date or a deal anchor are all real edits, and `undefined` cannot express them.
 */
export const updateIssueSchema = z
  .object({
    title: text(200).optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    details: z.string().trim().max(8000).nullish(),
    reference: text(80).nullish(),
    ownerUserId: identifier.nullish(),
    partyId: identifier.nullish(),
    dealId: z.number().int().positive().nullish(),
    dueAt: z.string().datetime().nullish(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to update",
  });
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

/**
 * An ordinary stage move.
 *
 * `escalated` is deliberately absent: it has its own route and its own
 * permission key, because raising a record above its owner is a different
 * authority from working it. Offering it here would make that key optional.
 */
export const transitionIssueSchema = z
  .object({
    toStage: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type TransitionIssueInput = z.infer<typeof transitionIssueSchema>;

export const escalateIssueSchema = z
  .object({
    /**
     * Required, unlike an ordinary move's. An escalation says somebody's
     * handling was not good enough; recording that without saying why leaves the
     * person it lands on with an accusation and no case.
     */
    reason: text(500),
  })
  .strict();
export type EscalateIssueInput = z.infer<typeof escalateIssueSchema>;

export const listTransitionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
  })
  .strict();
export type ListTransitionsQuery = z.infer<typeof listTransitionsQuerySchema>;

export const recordTypeParamSchema = z.enum(ISSUE_RECORD_TYPES);
