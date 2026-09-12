import { z } from "zod";

export const planSchema = z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]);
export type Plan = z.infer<typeof planSchema>;

export const purchaseAddonSchema = z.object({
  addonId: z.string().min(1).max(100),
  quantity: z.number().int().positive().max(10_000).default(1),
}).strict();
export type PurchaseAddonInput = z.infer<typeof purchaseAddonSchema>;

export const billingCycleSchema = z.enum(["monthly", "annual"]).default("monthly");
export type BillingCycle = z.infer<typeof billingCycleSchema>;

export const createOrderSchema = z.object({
  plan: planSchema,
  billingCycle: billingCycleSchema.optional(),
  couponId: z.number().int().positive().optional(),
}).strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const confirmCheckoutSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
}).strict();
export type ConfirmCheckoutInput = z.infer<typeof confirmCheckoutSchema>;

export const updateBillingProfileSchema = z.object({
  gstin: z.string().max(15).nullable().optional(),
  pan: z.string().max(10).nullable().optional(),
  billingName: z.string().max(255).nullable().optional(),
  billingEmail: z.string().email().max(255).nullable().optional(),
  addressLine1: z.string().max(255).nullable().optional(),
  addressLine2: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  pincode: z.string().max(10).nullable().optional(),
  // The column is `varchar(2)`, so anything longer is a silent truncation, not a value.
  country: z.string().trim().toUpperCase().length(2).nullable().optional(),
  isTaxExempt: z.boolean().optional(),
}).partial().strict();
export type UpdateBillingProfileInput = z.infer<typeof updateBillingProfileSchema>;

export const createCouponSchema = z.object({
  code: z.string().min(1).max(50).toUpperCase(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.number().positive(),
  maxUses: z.number().int().positive().max(1_000_000).optional(),
  applicablePlans: z.array(planSchema).max(planSchema.options.length).optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const updateCouponSchema = createCouponSchema.partial().extend({
  isActive: z.boolean().optional(),
}).strict();
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

export const validateCouponQuerySchema = z.object({
  code: z.string().min(1).max(100),
  plan: planSchema,
}).strict();
export type ValidateCouponQueryInput = z.infer<typeof validateCouponQuerySchema>;
