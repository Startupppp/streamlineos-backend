import { z } from "zod";

export const listAccountsSchema = z.object({
  status: z.enum(["ACCOUNT_OPENING", "QUERIES", "PLAN_SELECTED", "INVESTED"]).optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(500).optional(),
});

export const healthQuerySchema = z.object({
  status: z.enum(["healthy", "at_risk", "critical"]).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const createActivitySchema = z.object({
  activityType: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateRenewalSchema = z.object({
  renewalStage: z.enum(["upcoming", "in_discussion", "renewed", "churned"]).optional(),
  renewalDate: z.string().nullable().optional(),
  renewalNotes: z.string().nullable().optional(),
});

export const opportunitiesListSchema = z.object({
  clientId: z.coerce.number().optional(),
});

export const createOpportunitySchema = z.object({
  clientId: z.number().int().positive(),
  title: z.string().min(1).max(200),
  type: z.enum(["upsell", "cross_sell"]).default("upsell"),
  stage: z.enum(["identified", "proposed", "negotiating", "won", "lost"]).default("identified"),
  value: z.string().optional(),
  notes: z.string().max(2000).optional(),
  expectedCloseDate: z.string().optional(),
});

export const updateOpportunitySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  type: z.enum(["upsell", "cross_sell"]).optional(),
  stage: z.enum(["identified", "proposed", "negotiating", "won", "lost"]).optional(),
  value: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  expectedCloseDate: z.string().optional().nullable(),
});

export const onboardingItemsListSchema = z.object({
  clientId: z.coerce.number().optional(),
});

export const createOnboardingItemSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  assignedTo: z.string().optional(),
  dueDate: z.string().optional(),
  sortOrder: z.coerce.number().int().optional().default(0),
  templateId: z.coerce.number().int().optional(),
});

export const patchOnboardingItemSchema = z.object({
  completedAt: z.string().nullable().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
});

export const updateClientStatusSchema = z.object({
  status: z.enum(["ACCOUNT_OPENING", "QUERIES", "PLAN_SELECTED", "INVESTED"]),
  investmentAmount: z.string().optional(),
  planName: z.string().optional(),
  investmentDate: z.string().optional(),
  transactionRef: z.string().optional(),
});

export type ListAccountsInput = z.infer<typeof listAccountsSchema>;
export type HealthQueryInput = z.infer<typeof healthQuerySchema>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateRenewalInput = z.infer<typeof updateRenewalSchema>;
export type OpportunitiesListInput = z.infer<typeof opportunitiesListSchema>;
export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;
export type OnboardingItemsListInput = z.infer<typeof onboardingItemsListSchema>;
export type CreateOnboardingItemInput = z.infer<typeof createOnboardingItemSchema>;
export type PatchOnboardingItemInput = z.infer<typeof patchOnboardingItemSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateClientStatusInput = z.infer<typeof updateClientStatusSchema>;
