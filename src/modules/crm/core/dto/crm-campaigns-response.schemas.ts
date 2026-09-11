import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const campaignSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  status: z.string(),
  channel: z.string().nullable(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  targetAudience: z.string().nullable(),
  leads: z.number().int(),
  spend: z.string(),
  roi: z.string(),
  budgetAllocated: z.string().nullable(),
  budgetSpent: z.string().nullable(),
  utmCampaignKey: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const campaignsListSchema = z.object({
  items: z.array(campaignSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const campaignRoiSchema = z.object({
  spend: z.number(),
  leads: z.number().int(),
  converted: z.number().int(),
  deals: z.number().int(),
  revenueCents: z.number().int(),
  roi: z.number(),
});

const campaignLeadSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  source: z.string(),
  campaignId: z.number().int().nullable(),
  status: z.string(),
  priority: z.string(),
  potentialValue: z.string().nullable(),
  assignedToId: z.string().nullable(),
  company: z.string().nullable(),
  score: z.number().int().nullable(),
  followUpDate: nullableWireDate(),
  convertedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const campaignLeadsSchema = z.object({
  items: z.array(campaignLeadSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const campaignAttributionSchema = z.object({
  campaignId: z.number().int().nullable(),
  campaignName: z.string(),
  touchCount: z.number().int(),
  convertedLeads: z.number().int(),
  dealRevenueCents: z.number().int(),
  roi: z.number(),
});
