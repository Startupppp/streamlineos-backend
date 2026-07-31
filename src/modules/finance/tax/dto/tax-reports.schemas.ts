import { z } from "zod";

export const taxDateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rate: z.coerce.number().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(["json", "csv"]).default("json"),
});

export const taxDashboardQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type TaxDateRangeQuery = z.infer<typeof taxDateRangeQuerySchema>;
export type TaxDashboardQuery = z.infer<typeof taxDashboardQuerySchema>;
