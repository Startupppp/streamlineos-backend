import { z } from "zod";
import { invTxnTypeEnum } from "../../../../db/schema/common/enums";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const stockSummaryQuerySchema = paginationSchema;
export type StockSummaryQueryInput = z.infer<typeof stockSummaryQuerySchema>;

export const reorderQuerySchema = paginationSchema;
export type ReorderQueryInput = z.infer<typeof reorderQuerySchema>;

export const movementsQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * The report's own filter bar has offered a warehouse and a movement type
   * since it shipped, and this schema is `.strict()` — so every use of either
   * control answered 400 rather than filtering. Typed off the ledger's own enum
   * so the two cannot drift.
   */
  warehouseId: z.coerce.number().int().positive().optional(),
  transactionType: z.enum(invTxnTypeEnum.enumValues).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** G1. See `listTransactionsSchema.cursor` — same key, same reason. */
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export type MovementsQueryInput = z.infer<typeof movementsQuerySchema>;

export const valuationReportSchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  /** D5. The date the figure is quoted at, directly or via an accounting period. */
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ValuationReportInput = z.infer<typeof valuationReportSchema>;

export const slowMovingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).default(60),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type SlowMovingQueryInput = z.infer<typeof slowMovingQuerySchema>;

export const expiryReportSchema = z.object({
  withinDays: z.coerce.number().int().min(1).default(30),
  warehouseId: z.coerce.number().int().positive().optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ExpiryReportInput = z.infer<typeof expiryReportSchema>;
