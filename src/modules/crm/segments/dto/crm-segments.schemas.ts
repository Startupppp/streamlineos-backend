import { z } from "zod";
import { filterSchema } from "../../../reporting/dto/reporting.schemas";
import type { FilterNode } from "../../../reporting/compiler/query-description";
import { SEGMENT_MEMBER_PREVIEW_MAX } from "../segment-query";

/**
 * The HTTP boundary for segments.
 *
 * `filterSchema` is imported rather than restated, and that is the point of the
 * whole module. It is the reporting DTO's own filter parser: a finite six-level
 * tower rather than a `z.lazy`, so a body nesting `not` fifty thousand times is
 * a value this schema does not accept instead of a stack overflow *inside the
 * validator*. Rewriting that here would mean rewriting the reason it is shaped
 * that way, and a second copy would be the one somebody later "simplifies" into
 * a recursive schema.
 *
 * As in reporting, this is **not** the security gate. `compileQuery` re-checks
 * every name, arity, type and bound from scratch, because a criteria tree read
 * back out of `jsonb` was validated by whatever the DTO looked like on the day it
 * was written. What this file buys is a good refusal: a caller that sends a
 * malformed criterion gets a 400 naming the field, at the edge, before anything
 * reaches a service.
 */

const segmentName = z.string().trim().min(1).max(200);

/**
 * A segment's criteria, required and non-trivial.
 *
 * There is no "no criteria" segment. An empty tree evaluates to the whole
 * source, which is the parties list and already has a screen — allowing it would
 * make "everyone" storable under a name that says otherwise, and every later
 * reader of that name would be misled by it rather than by a bug.
 */
const criteria = filterSchema;

export const createSegmentSchema = z
  .object({
    name: segmentName,
    description: z.string().max(2000).optional(),
    /**
     * Named rather than inferred from the criteria. A tree of field names does
     * not say which source those names belong to — `name` and `status` exist on
     * more than one — so guessing would mean resolving a segment against
     * whichever source happened to match first.
     */
    source: z.string().min(1).max(64),
    criteria,
  })
  .strict();

export const updateSegmentSchema = z
  .object({
    name: segmentName.optional(),
    description: z.string().max(2000).nullable().optional(),
    criteria: criteria.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "an update must change something",
  });

/**
 * Evaluating criteria that have not been saved.
 *
 * The create form's "this matches 43 parties" before anybody commits to a name.
 * It answers with a count and nothing else — deliberately, and this is where the
 * line between this module and reporting is drawn. A preview that returned rows
 * would be an ad-hoc query endpoint with no saved artefact and no audit trail,
 * which is exactly `POST /crm/reporting/run`; duplicating it here is how the
 * second query engine arrives, one convenience at a time. How many is the one
 * thing you need to know before naming a set.
 */
export const previewSegmentSchema = z
  .object({ source: z.string().min(1).max(64), criteria })
  .strict();

export const listSegmentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

/**
 * The members read takes a bound and no offset — see `buildMemberQuery` for why
 * a segment has no stable cursor to page on.
 */
export const segmentMembersQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SEGMENT_MEMBER_PREVIEW_MAX)
      .default(SEGMENT_MEMBER_PREVIEW_MAX),
  })
  .strict();

export type CreateSegmentInput = z.infer<typeof createSegmentSchema>;
export type UpdateSegmentInput = z.infer<typeof updateSegmentSchema>;
export type PreviewSegmentInput = z.infer<typeof previewSegmentSchema>;
export type ListSegmentsQuery = z.infer<typeof listSegmentsQuerySchema>;
export type SegmentMembersQuery = z.infer<typeof segmentMembersQuerySchema>;

