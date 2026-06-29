import { z } from "zod";

export const recordEventSchema = z.object({
  type: z.enum([
    "new_subscription",
    "upgrade",
    "downgrade",
    "churn",
    "reactivation",
    "addon_purchase",
    "refund",
  ]),
  orgId: z.number().int().positive(),
  plan: z.string().optional(),
  previousPlan: z.string().optional(),
  mrr: z.number().int(),
  amount: z.number().int().optional(),
});

export const analyticsQuerySchema = z.object({
  period: z.enum(["3m", "6m", "12m"]).default("6m"),
});
