import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createPeriodSchema = z.object({
  periodKey: z.string().regex(/^\d{4}-\d{2}$/, "Must be YYYY-MM"),
  cutoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const listPeriodsSchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20, 100),
    status: z.enum(["open", "building", "built", "locked"]).optional(),
  })
  .strict();

export const sectionQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
    preview: z
      .string()
      .optional()
      .transform((v) => v === "true"),
  })
  .strict();

export const createAdjustmentSchema = z.object({
  periodId: z.number().int().positive().optional(),
  userId: z.string().min(1),
  adjustmentType: z.enum(["arrears", "recovery", "correction"]),
  section: z.enum([
    "employee_master",
    "compensation",
    "attendance",
    "leave",
    "overtime",
    "reimbursement",
    "deduction",
    "lifecycle",
  ]),
  amountCents: z.number().int().optional(),
  days: z.number().optional(),
  reason: z.string().min(1).max(1000),
  sourceChangeRef: z.record(z.string(), z.unknown()).optional(),
});

export const rejectAdjustmentSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type RejectAdjustmentInput = z.infer<typeof rejectAdjustmentSchema>;

export type CreatePeriodInput = z.infer<typeof createPeriodSchema>;
export type ListPeriodsInput = z.infer<typeof listPeriodsSchema>;
export type SectionQueryInput = z.infer<typeof sectionQuerySchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
