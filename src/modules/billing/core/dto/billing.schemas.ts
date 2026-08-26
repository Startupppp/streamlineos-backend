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
});
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

export const razorpayOrderSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
});

/*
  The same order, read back rather than created. `status` and `notes` only exist
  on a fetch, and `notes` is where the terms of the sale live -- the plan and the
  billing cycle the buyer actually paid for. Razorpay coerces note values to
  strings, so the record is typed that way rather than pretending it round-trips
  richer types.
*/
export const razorpayFetchedOrderSchema = razorpayOrderSchema.extend({
  status: z.string(),
  notes: z.record(z.string(), z.string()).default({}),
});
export type RazorpayFetchedOrder = z.infer<typeof razorpayFetchedOrderSchema>;
export type RazorpayOrder = z.infer<typeof razorpayOrderSchema>;

export const razorpayOrderErrorSchema = z.object({
  error: z.object({ description: z.string().optional() }).optional(),
});

/**
 * A Stripe PaymentIntent, narrowed to what the platform actually reads.
 *
 * Stripe returns some sixty fields. Parsing all of them would make every
 * unrelated addition to their API a schema change here, and parsing none of
 * them would let a shape change reach the database. These three are what
 * `PlatformOrder` promises.
 *
 * `amount` is minor units on both providers, which is the one place the two
 * genuinely agree and the reason `PlatformOrder` needed no conversion layer.
 */
export const stripePaymentIntentSchema = z.object({
  id: z.string(),
  amount: z.number(),
  /** Stripe answers lowercase; the platform stores ISO 4217 uppercase. */
  currency: z.string(),
  client_secret: z.string().nullable().optional(),
});

/*
  The same intent, read back. Stripe keeps arbitrary pairs in `metadata` where
  Razorpay keeps them in `notes`; both echo them verbatim on a fetch, which is
  what lets one activation path read the terms of the sale from either provider.
*/
export const stripeFetchedIntentSchema = stripePaymentIntentSchema.extend({
  status: z.string(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type StripeFetchedIntent = z.infer<typeof stripeFetchedIntentSchema>;
export type StripePaymentIntent = z.infer<typeof stripePaymentIntentSchema>;

export const stripeErrorSchema = z.object({
  error: z
    .object({ message: z.string().optional(), code: z.string().optional() })
    .optional(),
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
