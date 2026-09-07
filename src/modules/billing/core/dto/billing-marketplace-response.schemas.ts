import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

const marketplaceAppSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  iconUrl: z.string().nullable(),
  screenshotUrls: z.array(z.string()).nullable(),
  features: z.array(z.string()).nullable(),
  pricingType: z.string(),
  monthlyPrice: z.number().int(),
  annualPrice: z.number().int(),
  trialDays: z.number().int(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  requiredPlan: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const appInstallationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  appId: z.number().int(),
  installedBy: z.string(),
  status: z.string(),
  trialEndsAt: nullableWireDate(),
  installedAt: wireDate(),
  cancelledAt: nullableWireDate(),
});

export const appListResponseSchema = z.array(
  marketplaceAppSchema.extend({
    installation: appInstallationSchema.nullable(),
  }),
);

export const appInstallationResponseSchema = appInstallationSchema;

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

const aiCreditTransactionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  packId: z.number().int().nullable(),
  type: z.string(),
  amount: z.number(),
  balanceAfter: z.number(),
  description: z.string().nullable(),
  referenceId: z.string().nullable(),
  referenceType: z.string().nullable(),
  createdAt: wireDate(),
});

const orgAiCreditsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  balance: z.number(),
  autoTopUpEnabled: z.boolean(),
  autoTopUpPackId: z.number().int().nullable(),
  autoTopUpThreshold: z.number().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const aiCreditsWalletResponseSchema = orgAiCreditsSchema.extend({
  recentTransactions: z.array(aiCreditTransactionSchema),
  packs: z.array(aiCreditPackSchema),
});

export const aiCreditsTransactionPageSchema = cursorPageSchema(aiCreditTransactionSchema);

const aiCreditUsageByFeatureSchema = z.object({
  feature: z.string(),
  totalCredits: z.number(),
  requestCount: z.number().int(),
});

export const aiCreditsUsageResponseSchema = z.object({
  totalCredits: z.number(),
  requestCount: z.number().int(),
  byFeature: z.array(aiCreditUsageByFeatureSchema),
  period: z.object({ days: z.number().int(), from: z.string(), to: z.string() }),
});

export const autoTopUpResponseSchema = orgAiCreditsSchema;

export const purchaseAiCreditsResponseSchema = z.union([
  z.object({
    orderId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    keyId: z.string(),
    pack: aiCreditPackSchema,
  }),
  z.object({
    balance: z.number(),
    creditsAdded: z.number(),
    pack: aiCreditPackSchema,
  }),
]);

export { successSchema };
