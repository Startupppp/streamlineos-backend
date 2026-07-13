import { z } from "zod";

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
  threshold: z.number().int().min(0).optional(),
});
