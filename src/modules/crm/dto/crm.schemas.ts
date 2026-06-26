import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const organizationListSchema = paginationSchema.extend({
  search: z.string().optional(),
  q: z.string().optional(),
});

export const orgSizeSchema = z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]);

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: orgSizeSchema.optional(),
  website: z.string().url().optional().or(z.literal("")),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().optional(),
});

export const organizationUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  size: orgSizeSchema.optional().nullable(),
  website: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  healthScore: z.number().int().min(0).max(100).optional().nullable(),
  parentId: z.number().int().positive().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const territoryListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const territoryCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  states: z.array(z.string()).optional().default([]),
  cities: z.array(z.string()).optional().default([]),
  assignedReps: z.array(z.number()).optional().default([]),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

export const territoryUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  states: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  assignedReps: z.array(z.number()).optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const slaCreateSchema = z.object({
  name: z.string().min(1),
  appliesTo: z.enum(["lead", "deal", "both"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  firstResponseHours: z.number().int().positive(),
  resolutionHours: z.number().int().positive(),
});

export const slaUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  appliesTo: z.enum(["lead", "deal", "both"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  firstResponseHours: z.number().int().positive().optional(),
  resolutionHours: z.number().int().positive().optional(),
});

export const scoringRuleCreateSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "gt", "lt", "contains", "in"]),
  value: z.string().min(1),
  points: z.number().int().min(-1000).max(1000),
});

export const scoringRuleUpdateSchema = z.object({
  field: z.string().min(1).optional(),
  operator: z.enum(["eq", "gt", "lt", "contains", "in"]).optional(),
  value: z.string().min(1).optional(),
  points: z.number().int().min(-1000).max(1000).optional(),
});

const assignmentConditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.string(),
});

export const assignmentRuleCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  assignmentType: z.enum(["assign_user", "round_robin"]),
  assignToUserId: z.string().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(assignmentConditionSchema).optional(),
  priority: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const assignmentRuleUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  assignmentType: z.enum(["assign_user", "round_robin"]).optional(),
  assignToUserId: z.string().nullable().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(assignmentConditionSchema).optional(),
  priority: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const assignmentRuleReorderSchema = z.object({
  ruleIds: z.array(z.number().int().positive()),
});

export const emailTemplateCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
});

export const emailTemplateUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});

const webFormFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "email", "phone", "textarea", "select"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const webFormCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  fields: z.array(webFormFieldSchema).default([]),
  submitMessage: z.string().optional(),
  redirectUrl: z.string().url().optional().or(z.literal("")),
  isActive: z.boolean().optional().default(true),
});

export const webFormUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  fields: z.array(webFormFieldSchema).optional(),
  submitMessage: z.string().optional(),
  redirectUrl: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export type OrganizationListInput = z.infer<typeof organizationListSchema>;
export type OrganizationCreateInput = z.infer<typeof organizationCreateSchema>;
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>;
export type TerritoryListInput = z.infer<typeof territoryListSchema>;
export type TerritoryCreateInput = z.infer<typeof territoryCreateSchema>;
export type TerritoryUpdateInput = z.infer<typeof territoryUpdateSchema>;
export type SlaCreateInput = z.infer<typeof slaCreateSchema>;
export type SlaUpdateInput = z.infer<typeof slaUpdateSchema>;
export type ScoringRuleCreateInput = z.infer<typeof scoringRuleCreateSchema>;
export type ScoringRuleUpdateInput = z.infer<typeof scoringRuleUpdateSchema>;
export type AssignmentRuleCreateInput = z.infer<typeof assignmentRuleCreateSchema>;
export type AssignmentRuleUpdateInput = z.infer<typeof assignmentRuleUpdateSchema>;
export type AssignmentRuleReorderInput = z.infer<typeof assignmentRuleReorderSchema>;
export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>;
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>;
export type WebFormCreateInput = z.infer<typeof webFormCreateSchema>;
export type WebFormUpdateInput = z.infer<typeof webFormUpdateSchema>;
