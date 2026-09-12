import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const count = z.number().int().nonnegative();

export const subscriptionResponseSchema = z.object({
  subscription: z
    .object({
      id: z.number().int(),
      orgId: z.string(),
      plan: z.string(),
      status: z.string(),
      razorpaySubscriptionId: z.string().nullable(),
      razorpayCustomerId: z.string().nullable(),
      razorpayPlanId: z.string().nullable(),
      currentPeriodStart: nullableWireDate(),
      currentPeriodEnd: nullableWireDate(),
      trialEndsAt: nullableWireDate(),
      cancelledAt: nullableWireDate(),
      metadata: z.record(z.string(), z.unknown()).nullable(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
      payments: z.array(
        z.object({
          id: z.number().int(),
          orgId: z.string(),
          subscriptionId: z.number().int(),
          razorpayPaymentId: z.string().nullable(),
          razorpayOrderId: z.string().nullable(),
          amount: z.string().nullable(),
          amountPaise: z.number().int(),
          currency: z.string(),
          status: z.string(),
          paidAt: nullableWireDate(),
          metadata: z.record(z.string(), z.unknown()).nullable(),
          createdAt: wireDate(),
        }),
      ),
    })
    .nullable(),
  publicKeyId: z.string().nullable(),
  isConfigured: z.boolean(),
  platformCheckout: z.object({
    configured: z.boolean(),
    providerKey: z.string().nullable(),
    environment: z.enum(["test", "live"]).nullable(),
    publicKeyId: z.string().nullable(),
    webhookConfigured: z.boolean(),
    unavailableReason: z
      .enum(["no_credentials", "incomplete_credentials", "unsupported_provider"])
      .nullable(),
  }),
});

const planCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  monthlyPrice: z.number(),
  annualPrice: z.number(),
  monthlyPricePaise: z.number().int(),
  features: z.array(z.string()),
  maxEmployees: z.number().int().nullable(),
});

export const plansResponseSchema = z.object({
  plans: z.array(planCatalogEntrySchema),
  trialPlan: z.string(),
});

export const marketplaceOverviewResponseSchema = z.object({
  apps: z.array(z.unknown()),
  addons: z.array(z.unknown()),
});

export const checkoutResponseSchema = z.object({
  orderId: z.string(),
  purchaseId: z.number().int(),
  expiresAt: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  keyId: z.string().nullable(),
  environment: z.string().nullable(),
  plan: z.string(),
  billingCycle: z.string(),
  discountAmount: z.number().int(),
});

export const verifyActivateResponseSchema = z.object({
  success: z.literal(true),
  plan: z.string(),
  billingCycle: z.string(),
  status: z.string(),
  currentPeriodEnd: z.string().nullable(),
  alreadyActivated: z.boolean(),
});

const aiCreditPackSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  credits: z.number().int(),
  bonusCredits: z.number().int(),
  priceInPaise: z.number().int(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
});

export const purchaseAddonResponseSchema = z.object({
  orderId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  keyId: z.string(),
  pack: aiCreditPackSchema,
});

export const provisioningFailuresResponseSchema = z.object({
  events: z.array(
    z.object({
      id: z.number().int(),
      provider: z.string(),
      providerEventId: z.string(),
      eventType: z.string(),
      receivedAt: wireDate(),
    }),
  ),
  total: count,
});

export const validateCouponResponseSchema = z.object({
  valid: z.boolean(),
  couponId: z.number().int().nullable(),
  type: z.enum(["PERCENTAGE", "FIXED"]).nullable(),
  value: z.number().nullable(),
  discountAmount: z.number().nullable(),
  message: z.string(),
});

export const billingProfileResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  billingName: z.string().nullable(),
  billingEmail: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  country: z.string().nullable(),
  isTaxExempt: z.boolean(),
  metadata: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const addonItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  available: z.boolean(),
  href: z.string().optional(),
  priceInPaise: z.number().int().optional(),
});

export const listAddonsResponseSchema = z.object({
  addons: z.array(addonItemSchema),
});

const couponRedemptionSchema = z.object({
  id: z.number().int(),
  couponId: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  membershipId: z.number().int().nullable(),
  amount: z.string().nullable(),
  amountPaise: z.number().int(),
  redeemedAt: wireDate(),
});

export const couponRowSchema = z.object({
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
  orgId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const couponWithRedemptionsSchema = couponRowSchema.extend({
  redemptions: z.array(couponRedemptionSchema),
});

export const couponListResponseSchema = z.array(couponWithRedemptionsSchema);

export { successSchema };
