import { z } from "zod";

export const campaignListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.string().optional(),
});

export const campaignCreateSchema = z.object({
  name: z.string().min(1, "Name required").max(200),
  channel: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  utmCampaignKey: z.string().optional(),
  budgetAllocated: z.number().positive().optional(),
  description: z.string().optional(),
  targetAudience: z.string().optional(),
});

export const campaignUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  channel: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  utmCampaignKey: z.string().optional(),
  budgetAllocated: z.number().positive().optional(),
  status: z.enum(["active", "paused", "completed", "draft"]).optional(),
  description: z.string().optional(),
  targetAudience: z.string().optional(),
});

export type CampaignListQuery = z.infer<typeof campaignListSchema>;
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;
