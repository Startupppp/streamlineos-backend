import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

/**
 * `criteria` is the compiler's own `FilterNode` — a recursive and/or/not tree
 * over comparison leaves.
 *
 * Declared as the stored blob rather than modelled field by field: the recursion
 * is the compiler's vocabulary and re-stating it here would be a second copy of
 * `query-description.ts` that nothing keeps in step with the first. The rows
 * carrying it are not vacuous, so the contract still says something.
 */
const criteriaSchema = z.record(z.string(), z.unknown());

const segmentRowSchema = z.object({
  segmentId: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sourceKey: z.string(),
  criteria: criteriaSchema,
  createdByUserId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const segmentResponseSchema = segmentRowSchema;

/**
 * `listSegments` — a bare array, offset-paged by the query.
 *
 * The author's name comes off a projected LEFT JOIN to `users`, so it is null
 * for a segment whose author has left rather than the segment disappearing.
 */
export const listSegmentsResponseSchema = z.array(
  z.object({
    segmentId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    sourceKey: z.string(),
    createdByUserId: z.string().nullable(),
    createdByName: z.string().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
  }),
);

/** `describeSources` — already filtered to what this caller could evaluate. */
export const segmentSourcesResponseSchema = z.array(
  z.object({
    key: z.string(),
    label: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(["text", "enum", "number", "boolean", "timestamp", "date"]),
      }),
    ),
  }),
);

/**
 * `members` — a bounded sample and the exact size beside it.
 *
 * A member row's keys are the compiler's generated aliases (`c0`, `c1`, …) and
 * its values come back from the driver untyped, so the row itself can only be
 * described as a record; `columns` is what labels it.
 */
export const segmentMembersResponseSchema = z.object({
  columns: z.array(
    z.object({
      alias: z.string(),
      type: z.enum(["text", "enum", "number", "boolean", "timestamp", "date"]),
    }),
  ),
  rows: z.array(z.record(z.string(), z.unknown())),
  /** Every matching row, not the length of `rows`. */
  total: z.number().int(),
  truncated: z.boolean(),
});

/** `preview` — a count and nothing else; returning rows here would be an ad-hoc query. */
export const previewSegmentResponseSchema = z.object({ total: z.number().int() });

/** `deleteSegment` — a hard delete; a miss throws. */
export const deleteSegmentResponseSchema = z.object({ deleted: z.literal(true) });
