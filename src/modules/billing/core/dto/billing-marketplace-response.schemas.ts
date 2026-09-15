import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

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
  type: z.string(),
  amount: z.number(),
  balanceAfter: z.number(),
  feature: z.string().nullable(),
  model: z.string().nullable(),
  referenceId: z.string().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  createdAt: wireDate(),
});

const orgAiCreditsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  balance: z.number(),
  lifetimeGranted: z.number(),
  lifetimeConsumed: z.number(),
  autoTopUpEnabled: z.boolean(),
  autoTopUpPackId: z.number().int().nullable(),
  autoTopUpThreshold: z.number().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const aiCreditsWalletResponseSchema = z.object({
  wallet: orgAiCreditsSchema,
  recentTransactions: z.array(aiCreditTransactionSchema),
  packs: z.array(aiCreditPackSchema),
});

export const aiCreditsTransactionPageSchema = cursorPageSchema(aiCreditTransactionSchema);

const aiCreditUsageTotalsSchema = z.object({
  requests: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const aiCreditUsageByFeatureSchema = z.object({
  feature: z.string(),
  requests: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const aiCreditUsageByModelSchema = z.object({
  model: z.string(),
  requests: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const aiCreditUsageDailySchema = z.object({
  date: z.string(),
  requests: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
});

export const aiCreditsUsageResponseSchema = z.object({
  lifetimeConsumedCredits: z.number(),
  lifetimeConsumedMilli: z.number(),
  totals: aiCreditUsageTotalsSchema,
  byFeature: z.array(aiCreditUsageByFeatureSchema),
  byModel: z.array(aiCreditUsageByModelSchema),
  daily: z.array(aiCreditUsageDailySchema),
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

