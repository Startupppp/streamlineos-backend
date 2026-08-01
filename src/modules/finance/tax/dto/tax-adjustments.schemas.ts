import { z } from "zod";

export const adjustmentLineSchema = z.object({
  systemPurpose: z.enum(["TAX_PAYABLE", "TAX_RECEIVABLE"]).optional(),
  accountId: z.number().int().positive().optional(),
  debit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  credit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  description: z.string().max(500).optional(),
}).refine(
  (d) => d.systemPurpose !== undefined || d.accountId !== undefined,
  { message: "Each line must have systemPurpose or accountId" },
);

export const createTaxAdjustmentSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1).max(500),
  lines: z.array(adjustmentLineSchema).min(2),
});

export type CreateTaxAdjustmentInput = z.infer<typeof createTaxAdjustmentSchema>;
