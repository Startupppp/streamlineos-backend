import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const commissionRuleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  flatRate: z.string().nullable(),
  tiers: z.unknown().nullable(),
  appliesTo: z.string(),
  createdAt: wireDate(),
});

export const commissionSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userName: z.string().nullable(),
  dealId: z.number().int(),
  dealName: z.string().nullable(),
  dealValue: z.string().nullable(),
  commissionRate: z.string().nullable(),
  commissionAmount: z.string().nullable(),
  status: z.string(),
  paidAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const commissionsListSchema = z.object({
  items: z.array(commissionSchema),
  totalPending: z.number(),
  totalPaid: z.number(),
});

export const quotaSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userName: z.string().nullable(),
  period: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  targetRevenue: z.string(),
  actualRevenue: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  attainmentPct: z.number().int(),
});

export const createdQuotaSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  period: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  targetRevenue: z.string(),
  actualRevenue: z.string().nullable(),
  notes: z.string().nullable(),
  setById: z.string().nullable(),
  createdAt: wireDate(),
});

export const playbookEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  category: z.string(),
  title: z.string(),
  content: z.string(),
  sortOrder: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const salesKpisSchema = z.object({
  totalRevenue: z.number(),
  pipelineValue: z.number(),
  closeRate: z.number(),
  avgDealSize: z.number(),
  dealsWon: z.number().int(),
  totalDeals: z.number().int(),
  prevRevenue: z.number(),
  prevCloseRate: z.number(),
  prevAvgDealSize: z.number(),
});

export const salesFunnelSchema = z.array(
  z.object({
    stage: z.string(),
    count: z.number().int(),
    value: z.number(),
    color: z.string(),
    dropOffPct: z.number().nullable(),
  }),
);

export const salesLeaderboardSchema = z.array(
  z.object({
    repId: z.number().int(),
    name: z.string(),
    initials: z.string(),
    dealsWon: z.number().int(),
    totalDeals: z.number().int(),
    revenue: z.number(),
    winRate: z.number(),
  }),
);

export const salesRevenueVsGoalSchema = z.array(
  z.object({
    month: z.string(),
    actual: z.number(),
    target: z.number(),
  }),
);

export const salesVelocitySchema = z.object({
  avgDaysToClose: z.number(),
  medianDaysToClose: z.number(),
  fastestCloseDays: z.number(),
  slowestCloseDays: z.number(),
  dealCount: z.number().int(),
});

export const salesAgingSchema = z.array(
  z.object({
    repId: z.number().int(),
    name: z.string(),
    daysOpen: z.number().int(),
    count: z.number().int(),
  }),
);

export const salesCohortSchema = z.array(
  z.object({
    month: z.string(),
    wonCount: z.number().int(),
    wonValue: z.number(),
    newCount: z.number().int(),
    winRate: z.number(),
  }),
);

export const salesCycleLengthSchema = z.object({
  avgDays: z.number().int().nullable(),
  medianDays: z.number().int().nullable(),
  minDays: z.number().int().optional(),
  maxDays: z.number().int().optional(),
  histogram: z.array(
    z.object({ label: z.string(), count: z.number().int() }),
  ),
  totalDeals: z.number().int(),
});

export const salesLostAnalysisSchema = z.object({
  total: z.number().int(),
  totalValue: z.number(),
  reasons: z.array(
    z.object({
      reason: z.string(),
      count: z.number().int(),
      totalValue: z.number(),
      pct: z.number().int(),
    }),
  ),
});

const repComparisonDataSchema = z.object({
  repId: z.number().int(),
  name: z.string(),
  initials: z.string(),
  dealsWon: z.number().int(),
  totalDeals: z.number().int(),
  revenue: z.number(),
  winRate: z.number(),
  avgDealSize: z.number().int(),
  monthly: z.array(
    z.object({ month: z.string(), dealsWon: z.number().int(), revenue: z.number() }),
  ),
});

export const salesRepComparisonSchema = z.object({
  rep1: repComparisonDataSchema,
  rep2: repComparisonDataSchema,
});

export const removePlaybookEntrySchema = successSchema;

export { successSchema };
