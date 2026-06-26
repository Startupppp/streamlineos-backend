import { z } from "zod";

export const clientAccountStatusSchema = z.enum([
  "ACCOUNT_OPENING",
  "QUERIES",
  "PLAN_SELECTED",
  "INVESTED",
]);

export const listAccountsSchema = z.object({
  status: clientAccountStatusSchema.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const healthQuerySchema = z.object({
  status: z.enum(["healthy", "at_risk", "critical"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const opportunityListSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
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
  value: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  expectedCloseDate: z.string().nullable().optional(),
});

export const renewalStageSchema = z.enum(["upcoming", "in_discussion", "renewed", "churned"]);

export const updateRenewalSchema = z.object({
  renewalStage: renewalStageSchema.optional(),
  renewalDate: z.string().nullable().optional(),
  renewalNotes: z.string().nullable().optional(),
});

export const createActivitySchema = z.object({
  activityType: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const onboardingItemListSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
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

export const updateOnboardingItemSchema = z.object({
  completedAt: z.string().nullable().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

export const createOnboardingTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
});

export type ListAccountsInput = z.infer<typeof listAccountsSchema>;
export type HealthQueryInput = z.infer<typeof healthQuerySchema>;
export type OpportunityListInput = z.infer<typeof opportunityListSchema>;
export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;
export type UpdateRenewalInput = z.infer<typeof updateRenewalSchema>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type OnboardingItemListInput = z.infer<typeof onboardingItemListSchema>;
export type CreateOnboardingItemInput = z.infer<typeof createOnboardingItemSchema>;
export type UpdateOnboardingItemInput = z.infer<typeof updateOnboardingItemSchema>;
export type CreateOnboardingTemplateInput = z.infer<typeof createOnboardingTemplateSchema>;
