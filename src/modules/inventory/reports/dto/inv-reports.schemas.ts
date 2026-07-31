import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const stockSummaryQuerySchema = paginationSchema;
export type StockSummaryQueryInput = z.infer<typeof stockSummaryQuerySchema>;

export const reorderQuerySchema = paginationSchema;
export type ReorderQueryInput = z.infer<typeof reorderQuerySchema>;

export const movementsQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MovementsQueryInput = z.infer<typeof movementsQuerySchema>;

export const valuationReportSchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ValuationReportInput = z.infer<typeof valuationReportSchema>;

export const slowMovingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).default(60),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SlowMovingQueryInput = z.infer<typeof slowMovingQuerySchema>;

export const expiryReportSchema = z.object({
  withinDays: z.coerce.number().int().min(1).default(30),
  warehouseId: z.coerce.number().int().positive().optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ExpiryReportInput = z.infer<typeof expiryReportSchema>;
