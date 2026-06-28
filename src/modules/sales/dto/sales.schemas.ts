import { z } from "zod";

export const commissionRuleCreateSchema = z.object({
  name: z.string().min(1, "Rule name is required"),
  type: z.enum(["flat_percent", "tiered"]).default("flat_percent"),
  flatRate: z
    .string()
    .refine(
      (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
      "Rate must be a number between 0 and 100",
    )
    .optional(),
  tiers: z
    .array(
      z.object({
        minValue: z.number(),
        maxValue: z.number().optional(),
        rate: z.number(),
      }),
    )
    .optional(),
  appliesTo: z.string().default("all"),
});

export const commissionListSchema = z.object({
  userId: z.string().optional(),
  status: z.enum(["pending", "approved", "paid"]).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const commissionUpdateSchema = z.object({
  status: z.enum(["approved", "paid"]),
});

export const quotaListSchema = z.object({
  userId: z.string().optional(),
  period: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const quotaCreateSchema = z
  .object({
    userId: z.string().min(1, "User is required"),
    period: z.enum(["monthly", "quarterly", "yearly"]).default("monthly"),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
    targetRevenue: z
      .string()
      .min(1, "Target revenue is required")
      .refine(
        (v) => Number.isFinite(Number(v)) && Number(v) > 0,
        "Target revenue must be a positive number",
      ),
    notes: z.string().optional(),
  })
  .refine((data) => new Date(data.startDate) < new Date(data.endDate), {
    message: "Start date must be before end date",
    path: ["endDate"],
  });

export const playbookCreateSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().max(80).optional(),
  content: z.string().max(10000).optional(),
  sortOrder: z.number().int().optional(),
});

export const playbookUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().max(80).nullable().optional(),
  content: z.string().max(10000).optional(),
  sortOrder: z.number().int().optional(),
});

export const dashboardRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  repId: z.string().optional(),
});

export const leaderboardSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const agingSchema = z.object({
  threshold: z.coerce.number().int().min(1).max(365).optional(),
});

export const cohortSchema = z.object({
  months: z.coerce.number().int().min(1).max(12).optional(),
});

export const revenueVsGoalSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const repFilterSchema = z.object({
  repId: z.string().optional(),
});

export const repComparisonSchema = z.object({
  rep1: z.string(),
  rep2: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type CommissionRuleCreateInput = z.infer<typeof commissionRuleCreateSchema>;
export type CommissionListInput = z.infer<typeof commissionListSchema>;
export type CommissionUpdateInput = z.infer<typeof commissionUpdateSchema>;
export type QuotaListInput = z.infer<typeof quotaListSchema>;
export type QuotaCreateInput = z.infer<typeof quotaCreateSchema>;
export type PlaybookCreateInput = z.infer<typeof playbookCreateSchema>;
export type PlaybookUpdateInput = z.infer<typeof playbookUpdateSchema>;
export type DashboardRangeInput = z.infer<typeof dashboardRangeSchema>;
export type LeaderboardInput = z.infer<typeof leaderboardSchema>;
export type AgingInput = z.infer<typeof agingSchema>;
export type CohortInput = z.infer<typeof cohortSchema>;
export type RevenueVsGoalInput = z.infer<typeof revenueVsGoalSchema>;
export type RepFilterInput = z.infer<typeof repFilterSchema>;
export type RepComparisonInput = z.infer<typeof repComparisonSchema>;
