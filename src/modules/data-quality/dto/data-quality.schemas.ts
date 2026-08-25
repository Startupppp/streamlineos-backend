import { z } from "zod";
import {
  DATA_QUALITY_PRODUCERS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RESOLUTION_ACTIONS,
} from "../../../db/schema/crm/data-quality";
import { queryBoolean } from "../../../common/validation/query-boolean";

/**
 * The queue's boundary.
 *
 * The one number worth arguing about is `MAX_BULK`. Everything else here is
 * ordinary bounding.
 */

/**
 * How many findings one decision may cover.
 *
 * Four hundred is the ticket's own example — four hundred parties with the same
 * malformed number — and it is deliberately the cap rather than a round hundred,
 * because a bulk path that cannot express the motivating case is not a bulk
 * path. A larger group is resolved in successive decisions, and the response
 * says how many are left so the caller knows to repeat rather than assuming it
 * finished.
 */
export const MAX_BULK = 400;

const identifier = z.string().min(1).max(64);

/**
 * Which findings a decision covers.
 *
 * Two shapes, not one, and the distinction is the whole design. `ids` is a
 * person picking rows. `group` is a person recognising a systematic error and
 * naming its shape — and it never becomes a list of identifiers on the way to
 * the database, because the moment it did, "one decision" would be a lie told by
 * four hundred round trips.
 */
export const findingSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ids"),
      findingIds: z.array(identifier).min(1).max(MAX_BULK),
    })
    .strict(),
  z
    .object({
      kind: z.literal("group"),
      groupKey: z.string().min(1).max(200),
    })
    .strict(),
]);

export type FindingSelection = z.infer<typeof findingSelectionSchema>;

export const listFindingsQuerySchema = z
  .object({
    /**
     * Capped at the bulk limit rather than the usual hundred, so the page a
     * person is looking at and the selection they can act on are the same set.
     * A queue that shows more than it lets you resolve invites the wrong answer.
     */
    limit: z.coerce.number().int().min(1).max(MAX_BULK).default(50),
    cursor: z.string().min(1).max(512).optional(),

    status: z.enum(FINDING_STATUSES).default("open"),
    producer: z.enum(DATA_QUALITY_PRODUCERS).optional(),
    findingKind: z.string().min(1).max(120).optional(),
    severity: z.enum(FINDING_SEVERITIES).optional(),
    groupKey: z.string().min(1).max(200).optional(),
    partyId: identifier.optional(),
    assignedToId: identifier.optional(),
    /** Work nobody has picked up, which is the triager's first question. */
    unassignedOnly: queryBoolean.optional(),
    /** Age, in days, as a filter — the queue's whole reason for having one. */
    olderThanDays: z.coerce.number().int().min(0).max(3650).optional(),
    /**
     * Oldest first by default. A newest-first data-quality queue is a queue
     * where the oldest problem is never seen again.
     */
    order: z.enum(["oldest", "newest"]).default("oldest"),
  })
  .strict();

export type ListFindingsQuery = z.infer<typeof listFindingsQuerySchema>;

export const listGroupsQuerySchema = z
  .object({
    producer: z.enum(DATA_QUALITY_PRODUCERS).optional(),
    /** Groups, not findings — a tenant has few shapes of problem, many instances. */
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type ListGroupsQuery = z.infer<typeof listGroupsQuerySchema>;

export const healthQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
  .strict();

export type HealthQuery = z.infer<typeof healthQuerySchema>;

export const listResolutionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type ListResolutionsQuery = z.infer<typeof listResolutionsQuerySchema>;

export const assignFindingsSchema = z
  .object({
    selection: findingSelectionSchema,
    /**
     * `null` un-assigns, which is a real action: handing work back to the queue
     * has to be as easy as taking it, or people hoard items they cannot finish.
     */
    assigneeUserId: identifier.nullable(),
  })
  .strict();

export type AssignFindingsInput = z.infer<typeof assignFindingsSchema>;

export const resolveFindingsSchema = z
  .object({
    selection: findingSelectionSchema,
    action: z.enum(RESOLUTION_ACTIONS),
    reason: z.string().trim().min(1).max(500).optional(),
    /**
     * How many findings the caller expects this decision to cover.
     *
     * Optional, and worth having: a group grows between the screen rendering it
     * and the click, and a bulk decision that silently covers a different set
     * than the one a human reviewed is the failure mode this whole surface
     * exists to prevent. Supplied and wrong is a 409, not a shrug.
     *
     * Bounded by `MAX_BULK` because that is the most one decision can cover — a
     * group of 412 is decided as 400 and then 12, and the response's
     * `remainingInGroup` is what tells the caller to come back.
     */
    expectedCount: z.number().int().min(0).max(MAX_BULK).optional(),
  })
  .strict();

export type ResolveFindingsInput = z.infer<typeof resolveFindingsSchema>;

export const reverseResolutionSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export type ReverseResolutionInput = z.infer<typeof reverseResolutionSchema>;

/**
 * Producers with an ingest today.
 *
 * `import-uncertainty` is absent on purpose: the importer resolves every row to
 * a definite action and persists no uncertainty, so there is nothing to read.
 * Offering it here would make a sweep that finds nothing look like a dataset
 * with no import problems.
 */
export const SWEEPABLE_PRODUCERS = [
  "duplicate",
  "contradiction",
  "reachability",
  "staleness",
] as const;

export const scanSchema = z
  .object({
    producers: z.array(z.enum(SWEEPABLE_PRODUCERS)).min(1).optional(),
    /**
     * How long is too long without contact. Tenant-dependent — a quarterly
     * enterprise cycle and a weekly transactional one disagree — so it is an
     * argument rather than a constant.
     */
    staleAfterDays: z.number().int().min(7).max(3650).default(180),
  })
  .strict();

export type ScanInput = z.infer<typeof scanSchema>;
