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
  billingCycle: billingCycleSchema.optional(),
  couponId: z.number().int().positive().optional(),
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

/*
  Stripe's webhook envelope, which is not the shape Razorpay sends.

  Razorpay posts `{ event, payload.payment.entity }`; Stripe posts
  `{ id, type, data.object }` where the object is whichever resource the event is
  about. The two cannot share one schema, and pretending they can is how a
  second provider ends up silently dropping every delivery.

  `data.object` stays unknown here on purpose: the envelope is validated first so
  a malformed body is refused before anything reads the resource, and the
  resource schema is then chosen by `type`.
*/
export const stripeEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().optional(),
  livemode: z.boolean().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEventEnvelope = z.infer<typeof stripeEventEnvelopeSchema>;

/*
  A PaymentIntent as it arrives on `payment_intent.succeeded` and
  `payment_intent.payment_failed`.

  `latest_charge` is a string id unless the caller asked Stripe to expand it, and
  webhook deliveries are never expanded -- so a nullable string is the honest
  type rather than a union nothing here would use.
*/
export const stripeWebhookIntentSchema = z.object({
  id: z.string().min(1),
  object: z.literal("payment_intent"),
  amount: z.number().int(),
  amount_received: z.number().int().optional(),
  currency: z.string().min(1),
  status: z.string().min(1),
  latest_charge: z.string().nullable().optional(),
  receipt_email: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  last_payment_error: z
    .object({ message: z.string().optional(), code: z.string().optional() })
    .nullable()
    .optional(),
});
export type StripeWebhookIntent = z.infer<typeof stripeWebhookIntentSchema>;

/*
  A Charge as it arrives on `charge.refunded`.

  The trap here is `status`, which stays `"succeeded"` on a refunded charge --
  the refund is carried by `refunded` and `amount_refunded`, not by the
  lifecycle string. Reading `status` the way the Razorpay path does would record
  every refund as a successful payment.
*/
export const stripeWebhookChargeSchema = z.object({
  id: z.string().min(1),
  object: z.literal("charge"),
  amount: z.number().int(),
  amount_refunded: z.number().int(),
  currency: z.string().min(1),
  payment_intent: z.string().nullable().optional(),
  refunded: z.boolean(),
  receipt_email: z.string().nullable().optional(),
  billing_details: z
    .object({ email: z.string().nullable().optional() })
    .nullable()
    .optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type StripeWebhookCharge = z.infer<typeof stripeWebhookChargeSchema>;
