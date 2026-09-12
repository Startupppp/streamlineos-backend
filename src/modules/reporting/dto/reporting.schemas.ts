import { z } from "zod";
import {
  AGGREGATES,
  BINARY_OPERATORS,
  LIST_OPERATORS,
  QUERY_LIMITS,
  RANGE_OPERATORS,
  SORT_DIRECTIONS,
  UNARY_OPERATORS,
  type FilterNode,
  type QueryDescription,
} from "../compiler/query-description";
import { MAX_DAY_OF_MONTH, REPORT_CADENCES } from "../report-schedule-cadence";

/**
 * The HTTP boundary.
 *
 * This is not the security gate — `compileQuery` is, and it re-checks everything
 * here from scratch. What this file buys is a *good refusal*: a caller that
 * sends a malformed description gets a 400 naming the field, at the edge, before
 * anything reaches a service. Without it the same request would still be safe
 * and would arrive as a compiler error with a less helpful shape.
 *
 * Saying that plainly matters, because the opposite belief is how these modules
 * rot. If the DTO were the gate, then every path that does not go through it —
 * a saved description read back out of `jsonb`, a workflow step, a future
 * internal caller — would be unguarded, and nobody would notice until one of
 * them existed. The gate is downstream of all of them.
 */

/**
 * A literal in a filter.
 *
 * `null` is absent on purpose: nullness is asked with `is_null`, so there is no
 * `= NULL` to write. See `query-description.ts`.
 */
const scalarValue = z.union([
  z.string().max(QUERY_LIMITS.maxValueLength),
  z.number().finite(),
  z.boolean(),
]);

/**
 * A field name, as a name.
 *
 * Bounded and non-empty, and that is all — there is no pattern here and there
 * must not be one. A regex would look like the security control and would not be
 * it: what makes a name safe is that it is *looked up*, and a name that passes
 * any pattern still has to exist in the registry. Adding a pattern here would
 * invite the belief that a name reaching the compiler had been vetted.
 */
const fieldName = z.string().min(1).max(128);

const comparison = z.union([
  z
    .object({
      kind: z.literal("compare"),
      field: fieldName,
      operator: z.enum(UNARY_OPERATORS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("compare"),
      field: fieldName,
      operator: z.enum(BINARY_OPERATORS),
      value: scalarValue,
    })
    .strict(),
  z
    .object({
      kind: z.literal("compare"),
      field: fieldName,
      operator: z.enum(LIST_OPERATORS),
      values: z.array(scalarValue).min(1).max(QUERY_LIMITS.maxInValues),
    })
    .strict(),
  z
    .object({
      kind: z.literal("compare"),
      field: fieldName,
      operator: z.enum(RANGE_OPERATORS),
      from: scalarValue,
      to: scalarValue,
    })
    .strict(),
]);

/**
 * The filter tree, as a finite tower rather than a recursive schema.
 *
 * `z.lazy` would express this in three lines and would parse by recursing as
 * deep as the payload goes — so a body nesting `not` fifty thousand times
 * overflows the stack *inside the validator*, and a request that was supposed to
 * be rejected takes the process down instead. Building the schema as six
 * explicit levels means a seventh level is not a value this schema accepts, and
 * the parse recursion is bounded by six before it starts.
 *
 * The compiler bounds depth again, iteratively, for the callers that never come
 * through here.
 */
const MAX_BRANCHES = 20;

const filterAtDepth = (depth: number): z.ZodType<FilterNode> => {
  if (depth <= 1) return comparison as unknown as z.ZodType<FilterNode>;
  const inner = filterAtDepth(depth - 1);
  return z.union([
    comparison,
    z
      .object({ kind: z.literal("and"), nodes: z.array(inner).min(1).max(MAX_BRANCHES) })
      .strict(),
    z
      .object({ kind: z.literal("or"), nodes: z.array(inner).min(1).max(MAX_BRANCHES) })
      .strict(),
    z.object({ kind: z.literal("not"), node: inner }).strict(),
  ]) as unknown as z.ZodType<FilterNode>;
};

export const filterSchema = filterAtDepth(QUERY_LIMITS.maxFilterDepth);

const projection = z.union([
  z.object({ kind: z.literal("field"), field: fieldName }).strict(),
  z
    .object({
      kind: z.literal("aggregate"),
      aggregate: z.enum(AGGREGATES),
      field: fieldName.optional(),
    })
    .strict(),
]);

export const queryDescriptionSchema = z
  .object({
    source: z.string().min(1).max(64),
    select: z.array(projection).min(1).max(QUERY_LIMITS.maxSelect),
    filter: filterSchema.optional(),
    groupBy: z.array(fieldName).max(QUERY_LIMITS.maxGroupBy).optional(),
    orderBy: z
      .array(
        z
          .object({
            select: z.number().int().min(0).max(QUERY_LIMITS.maxSelect - 1),
            direction: z.enum(SORT_DIRECTIONS),
          })
          .strict(),
      )
      .max(QUERY_LIMITS.maxOrderBy)
      .optional(),
    /**
     * Required rather than defaulted. A report with no stated limit is a report
     * whose author did not think about how much it returns, and defaulting hides
     * that decision instead of asking for it.
     */
    limit: z.number().int().min(1).max(QUERY_LIMITS.maxLimit),
    offset: z.number().int().min(0).max(QUERY_LIMITS.maxOffset).optional(),
  })
  .strict();

/**
 * `.strict()` throughout, and that is the one line here that does security work.
 *
 * A non-strict object silently drops unknown keys, so a description carrying
 * `{ having: "1=1", rawSql: "…" }` would parse cleanly and look like a valid
 * description. It would still be safe — the compiler reads named fields and
 * would never see those — but the request would be *accepted*, and an attacker
 * probing for an escape hatch would get a 200 back and keep going. Rejecting the
 * unknown key says no at the door.
 */
export type QueryDescriptionInput = z.infer<typeof queryDescriptionSchema>;

const reportName = z.string().min(1).max(200);

export const createDefinitionSchema = z
  .object({
    name: reportName,
    description: z.string().max(2000).optional(),
    query: queryDescriptionSchema,
  })
  .strict();

export const updateDefinitionSchema = z
  .object({
    name: reportName.optional(),
    description: z.string().max(2000).nullable().optional(),
    query: queryDescriptionSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "an update must change something",
  });

export const runAdHocSchema = z.object({ query: queryDescriptionSchema }).strict();

/** Phase 5 ticket 15 — a plain-language question, proposed as a query description. */
export const nlProposeSchema = z.object({ question: z.string().min(1).max(500) }).strict();

/** Overrides for a saved report, so one definition serves a date range picker. */
export const runDefinitionSchema = z
  .object({
    limit: z.number().int().min(1).max(QUERY_LIMITS.maxLimit).optional(),
    offset: z.number().int().min(0).max(QUERY_LIMITS.maxOffset).optional(),
  })
  .strict();

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export type CreateDefinitionInput = z.infer<typeof createDefinitionSchema>;
export type UpdateDefinitionInput = z.infer<typeof updateDefinitionSchema>;
export type RunAdHocInput = z.infer<typeof runAdHocSchema>;
export type NlProposeInput = z.infer<typeof nlProposeSchema>;
export type RunDefinitionInput = z.infer<typeof runDefinitionSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * The DTO's output is structurally the compiler's input, so the cast is a
 * restatement rather than a claim. It is written as a function so there is
 * exactly one place to look if the two ever drift.
 */
export const asQueryDescription = (input: QueryDescriptionInput): QueryDescription =>
  input as QueryDescription;

/**
 * Scheduling a saved report.
 *
 * `dayOfMonth` stops at 28 rather than clamping 29-31, and that is the one
 * bound here worth defending: a schedule set to "the 31st" either skips
 * February entirely or silently becomes "the 28th" for one month a year, and
 * both are a report that did not arrive when somebody was told it would.
 * Refusing at the boundary makes the operator say which they meant.
 */
const recipientEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

export const createScheduleSchema = z
  .object({
    reportDefinitionId: z.string().min(1).max(64),
    cadence: z.enum(REPORT_CADENCES),
    hourOfDay: z.number().int().min(0).max(23),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(MAX_DAY_OF_MONTH).optional(),
    /**
     * At least one. A schedule with no recipients runs the report, spends the
     * database time and delivers it to nobody — which is indistinguishable from
     * a broken schedule and costs the same.
     */
    recipients: z.array(recipientEmail).min(1).max(50),
  })
  .strict();

export const updateScheduleSchema = z
  .object({
    cadence: z.enum(REPORT_CADENCES).optional(),
    hourOfDay: z.number().int().min(0).max(23).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(MAX_DAY_OF_MONTH).optional(),
    enabled: z.boolean().optional(),
    recipients: z.array(recipientEmail).min(1).max(50).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "an update must change something",
  });

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
