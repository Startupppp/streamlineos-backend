import { z } from "zod";

/**
 * C5 — what a transfer recommendation is asked about.
 *
 * The scope mirrors `forecast-scope.schemas.ts`: a variant in the path, a
 * history window in the query. There is no `warehouseId` here because the whole
 * point of the plan is to compare every site the caller can see against every
 * other one; naming a single warehouse would answer a different question.
 */
export const transferPlanQuerySchema = z
  .object({
    weeks: z.coerce.number().int().min(1).max(260).optional(),
  })
  .strict();
export type TransferPlanQuery = z.infer<typeof transferPlanQuerySchema>;

/**
 * Approving one recommendation.
 *
 * The body names the **move**, never the amount. The recommended quantity is
 * re-derived from the live plan at approval time and a client-sent quantity is
 * not accepted at all — `.strict()` rejects one rather than ignoring it, because
 * a caller sending a quantity here is asking for something this endpoint will
 * not do, and silently doing something else is worse than a 400.
 */
export const approveTransferRecommendationSchema = z
  .object({
    productVariantId: z.number().int().positive(),
    fromWarehouseId: z.number().int().positive(),
    toWarehouseId: z.number().int().positive(),
    weeks: z.number().int().min(1).max(260).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: "A transfer must move stock between two different warehouses",
  });
export type ApproveTransferRecommendationInput = z.infer<
  typeof approveTransferRecommendationSchema
>;
