import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";
import { enterpriseQuoteStatusEnum } from "../../../../db/schema/common/enums";

export const affiliateRowSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  orgId: z.string(),
  referralCode: z.string(),
  status: z.string(),
  commissionType: z.string(),
  commissionRate: z.number().int(),
  totalEarned: z.number().int(),
  totalPaid: z.number().int(),
  pendingPayout: z.number().int(),
  clickCount: z.number().int(),
  signupCount: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const affiliateCommissionRowSchema = z.object({
  id: z.number().int(),
  affiliateId: z.number().int(),
  referredOrgId: z.string(),
  subscriptionId: z.number().int().nullable(),
  amountInPaise: z.number().int(),
  status: z.string(),
  paidAt: nullableWireDate(),
  metadata: z.unknown().nullable(),
  createdAt: wireDate(),
});

export const affiliateDashboardResponseSchema = z
  .object({
    affiliate: affiliateRowSchema,
    commissions: z.array(affiliateCommissionRowSchema),
  })
  .nullable();

export const affiliatePayoutResponseSchema = z.object({
  success: z.literal(true),
  amount: z.number(),
  message: z.string(),
});

export const referralRowSchema = z.object({
  id: z.number().int(),
  referrerOrgId: z.string(),
  referrerUserId: z.string(),
  referredEmail: z.string(),
  referredOrgId: z.string().nullable(),
  referralCode: z.string(),
  status: z.string(),
  rewardGranted: z.boolean(),
  signedUpAt: nullableWireDate(),
  activatedAt: nullableWireDate(),
  rewardedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const referralListResponseSchema = z.array(referralRowSchema);

const revenueMetricsSchema = z.object({
  mrr: z.number(),
  arr: z.number(),
  arpu: z.number(),
  churnRate: z.number(),
  activeSubscriptions: z.number().int(),
  trialSubscriptions: z.number().int(),
  ltv: z.number(),
  cac: z.number(),
  expansionRevenue: z.number(),
  trialConversionRate: z.number(),
  refundRate: z.number(),
});

const timeSeriesEntrySchema = z.object({
  month: z.string(),
  newMrr: z.number(),
  churnMrr: z.number(),
  netNew: z.number(),
});

export const analyticsResponseSchema = z.object({
  metrics: revenueMetricsSchema,
  timeSeries: z.array(timeSeriesEntrySchema),
});

const enterpriseQuoteBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  quoteRef: z.string(),
  subject: z.string(),
  planTier: z.string(),
  requestedSeats: z.number().int(),
  negotiatedSeats: z.number().int(),
  pricePerSeatInPaise: z.number().int(),
  contractTermMonths: z.number().int(),
  contractTerms: z.string().nullable(),
  status: z.enum(enterpriseQuoteStatusEnum.enumValues),
  approverId: z.string().nullable(),
  approvalNotes: z.string().nullable(),
  approvedAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  acceptedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  validUntil: z.string(),
  notes: z.string().nullable(),
  dealId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  createdById: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const enterpriseQuoteListItemSchema = z.object({
  id: z.number().int(),
  quoteRef: z.string(),
  subject: z.string(),
  planTier: z.string(),
  negotiatedSeats: z.number().int(),
  pricePerSeatInPaise: z.number().int(),
  contractTermMonths: z.number().int(),
  status: z.enum(enterpriseQuoteStatusEnum.enumValues),
  validUntil: z.string(),
  createdAt: wireDate(),
  dealName: z.string().nullable(),
  clientName: z.string().nullable(),
});

export const enterpriseQuoteListResponseSchema = cursorPageSchema(enterpriseQuoteListItemSchema);

export const enterpriseQuoteCreateResponseSchema = z.object({
  id: z.number().int(),
  quoteRef: z.string(),
});

export const enterpriseQuoteDetailResponseSchema = enterpriseQuoteBaseSchema.extend({
  totalValueInPaise: z.number().int(),
  deal: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  client: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  approver: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export { successSchema };
