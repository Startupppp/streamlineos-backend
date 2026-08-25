import { z } from "zod";

export const planSchema = z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]);
export type Plan = z.infer<typeof planSchema>;

export const purchaseAddonSchema = z.object({
  addonId: z.string().min(1),
  quantity: z.number().int().positive().default(1),
});
export type PurchaseAddonInput = z.infer<typeof purchaseAddonSchema>;

export const billingCycleSchema = z.enum(["monthly", "annual"]).default("monthly");
export type BillingCycle = z.infer<typeof billingCycleSchema>;

export const createOrderSchema = z.object({
  plan: planSchema,
  billingCycle: billingCycleSchema.optional(),
  couponId: z.number().int().positive().optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
  plan: planSchema,
  couponId: z.number().int().positive().optional(),
});
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

export const razorpayOrderSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
});
export type RazorpayOrder = z.infer<typeof razorpayOrderSchema>;

export const razorpayOrderErrorSchema = z.object({
  error: z.object({ description: z.string().optional() }).optional(),
});

export const updateBillingProfileSchema = z.object({
  gstin: z.string().max(15).nullable().optional(),
  pan: z.string().max(10).nullable().optional(),
  billingName: z.string().max(255).nullable().optional(),
  billingEmail: z.string().email().max(255).nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  pincode: z.string().max(10).nullable().optional(),
  isTaxExempt: z.boolean().optional(),
}).partial();
export type UpdateBillingProfileInput = z.infer<typeof updateBillingProfileSchema>;

const razorpayPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().optional(),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  method: z.string().optional(),
  email: z.string().optional(),
  description: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
  invoice_id: z.string().optional(),
  created_at: z.number().optional(),
});

export const webhookEventSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: razorpayPaymentSchema }).optional(),
  }),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
export type RazorpayPayment = z.infer<typeof razorpayPaymentSchema>;

export const createCouponSchema = z.object({
  code: z.string().min(1).max(50).toUpperCase(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.number().positive(),
  maxUses: z.number().int().positive().optional(),
  applicablePlans: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const updateCouponSchema = createCouponSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
