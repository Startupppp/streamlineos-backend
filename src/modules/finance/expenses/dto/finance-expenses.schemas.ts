import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const receiptListSchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

export const patchReceiptSchema = z.object({
  merchant: z.string().min(1).max(200).optional(),
  receiptNumber: z.string().min(1).max(100).optional(),
  taxAmount: z.number().nonnegative().optional(),
  categoryId: z.number().int().positive().optional(),
});

export const createBatchSchema = z.object({
  name: z.string().min(1).max(200),
  expenseIds: z.array(z.number().int().positive()).min(1).max(500),
});

export const payBatchSchema = z.object({
  paidDate: z.string().min(10),
  bankAccountId: z.number().int().positive().optional(),
});

export const createPolicySchema = z.object({
  name: z.string().min(1).max(200),
  categoryId: z.number().int().positive().optional(),
  maxAmount: z.number().nonnegative().optional(),
  requiresReceiptAbove: z.number().nonnegative().optional(),
  requiresApprovalAbove: z.number().nonnegative().optional(),
  isActive: z.boolean().default(true),
});

export const updatePolicySchema = createPolicySchema.partial();

export const batchListSchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
  status: z.enum(["DRAFT", "APPROVED", "PAID"]).optional(),
});

export type ReceiptListInput = z.infer<typeof receiptListSchema>;
export type PatchReceiptInput = z.infer<typeof patchReceiptSchema>;
export type CreateBatchInput = z.infer<typeof createBatchSchema>;
export type PayBatchInput = z.infer<typeof payBatchSchema>;
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
export type BatchListInput = z.infer<typeof batchListSchema>;
