import { z } from "zod";
import { invTxnTypeEnum } from "../../../../../db/schema/common/enums";

/**
 * F5 — the natural-language report builder's config, and the whole of the
 * defence.
 *
 * ## The one thing a model may produce
 *
 * A member of `INV_REPORT_IDS`, plus a closed object of scalars. That is all.
 * The rules that make it safe are structural rather than defensive:
 *
 * 1. **There is no string field anywhere in a filter.** Not one. Every filter
 *    value is an integer with bounds, a date matching `YYYY-MM-DD`, or a member
 *    of an enum this repository owns. A SQL fragment, a table name, a comment
 *    marker, a quote — none of them has a field to arrive in. An injection
 *    payload is not "escaped" here; there is no channel it fits through.
 * 2. **The report id is a lookup key, never a value.** It selects an entry in a
 *    table compiled into this repository, and that entry's `run` is a function
 *    somebody wrote. The string itself is never interpolated into SQL, a route,
 *    a column name or a permission key.
 * 3. **The union is discriminated and every object is `.strict()`.** A filter
 *    that belongs to a different report is not ignored — it fails validation, so
 *    `{"report":"expiry","filters":{"days":30}}` is rejected rather than
 *    silently running with a default.
 * 4. **The server owns everything the model was not asked for**: the
 *    organisation, the asker, warehouse scope, page, row cap, sort order,
 *    columns and the permission check. None of those is expressible in this
 *    schema, so none of them can be influenced by what the model emits.
 *
 * A model that writes `"stock_summary'; DROP TABLE inv_lots; --"` fails
 * `z.literal` and the deterministic plan runs instead. A model that writes
 * `{"warehouseId": "7 OR 1=1"}` fails `z.number().int()`. A model that writes
 * `{"fromDate": "2024-01-01'; --"}` fails the date pattern. The failure is
 * always the same: nothing runs, the fallback plan runs instead, and the request
 * still gets an answer.
 *
 * ## Why not SQL
 *
 * Because "natural language to SQL, then validate the SQL" is a parser arms race
 * with a database on the losing side, and because a correct-looking `SELECT`
 * still reads whatever the connection can reach — which is every warehouse, not
 * the asker's. Emitting a config instead means the asker's own permissions
 * filter the result in the predicate of a query the server wrote, which is
 * exactly what §4 requires and what no amount of SQL review can deliver.
 */

/**
 * The reports a question can resolve to. Each has an entry in
 * `inv-report-catalog.ts`; a member added here without one fails at module load.
 */
export const INV_REPORT_IDS = [
  "stock_summary",
  "reorder",
  "movements",
  "slow_moving",
  "expiry",
  "valuation",
] as const;
export type InvReportId = (typeof INV_REPORT_IDS)[number];

/** `YYYY-MM-DD` and nothing else. A closed lexical domain: digits and dashes. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A warehouse the *server* then checks against the asker's own scope. */
const warehouseId = z.number().int().positive();

/**
 * The per-report filter shapes. These are the single definition: the union
 * below is built from them, and the catalog references the same objects, so a
 * report cannot accept one set of filters and be described as accepting another.
 */
export const INV_REPORT_FILTERS = {
  /** Position by SKU and location. Server-paged; nothing to narrow. */
  stock_summary: z.object({}).strict(),
  /** What is below its reorder point. Organisation-wide by construction. */
  reorder: z.object({}).strict(),
  movements: z
    .object({
      fromDate: isoDate.optional(),
      toDate: isoDate.optional(),
      warehouseId: warehouseId.optional(),
      /** Typed off the ledger's own enum, so the two cannot drift. */
      transactionType: z.enum(invTxnTypeEnum.enumValues).optional(),
    })
    .strict(),
  slow_moving: z
    .object({
      /** How long without an outbound movement counts as slow. */
      days: z.number().int().min(1).max(365).optional(),
    })
    .strict(),
  expiry: z
    .object({
      withinDays: z.number().int().min(1).max(365).optional(),
      warehouseId: warehouseId.optional(),
      status: z.enum(["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]).optional(),
    })
    .strict(),
  valuation: z
    .object({
      warehouseId: warehouseId.optional(),
      categoryId: z.number().int().positive().optional(),
      asOfDate: isoDate.optional(),
    })
    .strict(),
} as const satisfies Record<InvReportId, z.ZodType>;

/**
 * The wire schema, written out member by member rather than mapped.
 *
 * `z.discriminatedUnion` wants a literal tuple, and building one with `.map()`
 * gives up the literal types that make the discrimination work — the shape that
 * type-checks but stops narrowing. Six explicit lines is a small price for the
 * compiler proving that `spec.report === "expiry"` implies `spec.filters` is the
 * expiry shape.
 */
export const invReportSpecSchema = z.discriminatedUnion("report", [
  z.object({ report: z.literal("stock_summary"), filters: INV_REPORT_FILTERS.stock_summary }).strict(),
  z.object({ report: z.literal("reorder"), filters: INV_REPORT_FILTERS.reorder }).strict(),
  z.object({ report: z.literal("movements"), filters: INV_REPORT_FILTERS.movements }).strict(),
  z.object({ report: z.literal("slow_moving"), filters: INV_REPORT_FILTERS.slow_moving }).strict(),
  z.object({ report: z.literal("expiry"), filters: INV_REPORT_FILTERS.expiry }).strict(),
  z.object({ report: z.literal("valuation"), filters: INV_REPORT_FILTERS.valuation }).strict(),
]);
export type InvReportSpec = z.infer<typeof invReportSpecSchema>;

/**
 * The request. A question and, optionally, a site the *asker* named.
 *
 * The question is bounded for the same two reasons it is bounded on the copilot:
 * an unbounded question is a prompt-injection carrier with a token bill on it,
 * and nobody should be able to paste a document into a box that costs money.
 */
export const INV_REPORT_QUESTION_MAX = 400;

export const invReportAskSchema = z
  .object({
    question: z.string().trim().min(3).max(INV_REPORT_QUESTION_MAX),
    /**
     * A warehouse the asker pinned, as opposed to one the model proposed. The
     * two are treated differently on purpose — see `inv-report-builder.service`.
     */
    warehouseId: z.number().int().positive().optional(),
  })
  .strict();
export type InvReportAskInput = z.infer<typeof invReportAskSchema>;

/**
 * Running or exporting a spec the caller already has.
 *
 * No question, so no model call and no credits — this is the "I looked at the
 * preview and now I want the file" path, and re-deriving the spec from the
 * question would let the same words produce a different report the second time.
 * The spec is re-validated through the same union and re-scoped against the same
 * permissions: a spec is data the client holds, never a capability it was
 * granted.
 */
export const invReportRunSchema = z.object({ spec: invReportSpecSchema }).strict();
export type InvReportRunInput = z.infer<typeof invReportRunSchema>;
