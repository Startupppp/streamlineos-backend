import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const taxDateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rate: z.coerce.number().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  format: z.enum(["json", "csv"]).default("json"),
}).strict();

/**
 * `liability-summary` answers ONE aggregate document for the whole `from`..`to`
 * range: `computeLiabilitySummary` destructures `{ from, to }` and nothing else,
 * and its cache key is `liability:${from}:${to}`. It inherited `cursor` and
 * `limit` only from sharing `taxDateRangeQuerySchema` with `output` and `input`,
 * which really do page — so the route advertised a cursor it silently ignored.
 * Omitted rather than re-declared so the surviving fields cannot drift apart.
 */
export const taxLiabilitySummaryQuerySchema = taxDateRangeQuerySchema.omit({
  cursor: true,
  limit: true,
});

export const taxDashboardQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export type TaxDateRangeQuery = z.infer<typeof taxDateRangeQuerySchema>;
export type TaxDashboardQuery = z.infer<typeof taxDashboardQuerySchema>;
export type TaxLiabilitySummaryQuery = z.infer<typeof taxLiabilitySummaryQuerySchema>;
