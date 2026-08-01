import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const overviewQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const dateRangeSchema = z.object({
  from: isoDate,
  to: isoDate,
});

export const statementQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  format: z.enum(["json", "csv"]).default("json"),
});

export const analyticsDateRangeSchema = z.object({
  from: isoDate,
  to: isoDate,
  format: z.enum(["json", "csv"]).default("json"),
});

export const budgetVsActualQuerySchema = z.object({
  budgetId: z.coerce.number().int().positive(),
  from: isoDate,
  to: isoDate,
  format: z.enum(["json", "csv"]).default("json"),
});

export const workingCapitalQuerySchema = z.object({
  asOf: isoDate.optional(),
});

export const cashRunwayQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

export type OverviewQuery = z.infer<typeof overviewQuerySchema>;
export type DateRangeQuery = z.infer<typeof dateRangeSchema>;
export type BudgetVsActualQuery = z.infer<typeof budgetVsActualQuerySchema>;
export type WorkingCapitalQuery = z.infer<typeof workingCapitalQuerySchema>;
export type CashRunwayQuery = z.infer<typeof cashRunwayQuerySchema>;
