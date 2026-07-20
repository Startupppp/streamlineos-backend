import { z } from "zod";

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

export const consumeCreditsSchema = z.object({
  amount: z.number().int().positive(),
  feature: z.string().max(100),
  model: z.string().max(100).optional(),
  referenceId: z.string().max(100).optional(),
});

export const autoTopUpSchema = z.object({
  enabled: z.boolean(),
  packId: z.number().int().positive().optional(),
  threshold: z.number().min(0).optional(),
});

export const listTransactionsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsSchema>;
