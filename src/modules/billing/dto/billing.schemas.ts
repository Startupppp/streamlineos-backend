import { z } from "zod";

export const planSchema = z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]);
export type Plan = z.infer<typeof planSchema>;

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
