import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const createPromotionSchema = z.object({
  code: z.string().min(1).max(50).toUpperCase(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.number().positive(),
  maxUses: z.number().int().positive().max(10_000_000).optional(),
  applicablePlans: z.array(z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"])).optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

export const updatePromotionSchema = createPromotionSchema.partial().extend({
  isActive: z.boolean().optional(),
}).strict();
export type UpdatePromotionInput = z.infer<typeof updatePromotionSchema>;

export const promotionIdParams = z.object({
  promotionId: z.coerce.number().int().positive(),
}).strict();

export const promotionRowSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.string(),
  minPurchase: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  usedCount: z.number().int(),
  isActive: z.boolean(),
  applicablePlans: z.array(z.string()).nullable(),
  expiresAt: nullableWireDate(),
  orgId: z.null(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const promotionListResponseSchema = z.object({
  promotions: z.array(promotionRowSchema),
});

export const legacyTenantCouponRowSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  orgId: z.string().nullable(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.string(),
  usedCount: z.number().int(),
  maxUses: z.number().int().nullable(),
  isActive: z.boolean(),
  redemptionCount: z.number().int(),
  createdAt: wireDate(),
});

export const legacyTenantCouponListResponseSchema = z.object({
  coupons: z.array(legacyTenantCouponRowSchema),
});
