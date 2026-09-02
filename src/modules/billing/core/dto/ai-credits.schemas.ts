import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const aiCreditsUsageQuerySchema = z.object({
  days: z.coerce.number().refine((v) => v === 7 || v === 30 || v === 90, {
    message: "days must be 7, 30, or 90",
  }).default(30),
});

export const purchaseAiPackSchema = z.object({
  packId: z.coerce.number().int().positive(),
  paymentId: z.string().max(255).optional(),
  orderId: z.string().max(255).optional(),
  signature: z.string().max(512).optional(),
}).strict();

export type PurchaseAiPackInput = z.infer<typeof purchaseAiPackSchema>;

export const AUTO_TOP_UP_MAX_THRESHOLD_CREDITS = 100_000;

export const autoTopUpSchema = z.object({
  enabled: z.boolean(),
  packId: z.number().int().positive().optional(),
  // A threshold above every purchasable pack re-triggers the top-up it just settled.
  threshold: z.number().min(0).max(AUTO_TOP_UP_MAX_THRESHOLD_CREDITS).optional(),
}).strict();

export const listTransactionsSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});
