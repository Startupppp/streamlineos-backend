import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const aiCreditsUsageQuerySchema = z.object({
  days: z.coerce.number().refine((v) => v === 7 || v === 30 || v === 90, {
    message: "days must be 7, 30, or 90",
  }).default(30),
});

export const purchaseAiPackSchema = z.object({
  packId: z.coerce.number().int().positive(),
  paymentId: z.string().optional(),
  orderId: z.string().optional(),
  signature: z.string().optional(),
});

export type PurchaseAiPackInput = z.infer<typeof purchaseAiPackSchema>;

export const autoTopUpSchema = z.object({
  enabled: z.boolean(),
  packId: z.number().int().positive().optional(),
  threshold: z.number().min(0).optional(),
});

export const listTransactionsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});
