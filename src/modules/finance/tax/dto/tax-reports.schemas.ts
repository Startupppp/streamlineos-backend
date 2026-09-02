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

export const taxDashboardQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export type TaxDateRangeQuery = z.infer<typeof taxDateRangeQuerySchema>;
export type TaxDashboardQuery = z.infer<typeof taxDashboardQuerySchema>;
