import { z } from "zod";

const conditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.string(),
});

const scoringOperatorEnum = z.enum(["eq", "gt", "lt", "contains", "in"]);

export const assignmentRuleCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  assignmentType: z.enum(["assign_user", "round_robin"]),
  assignToUserId: z.string().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(conditionSchema).optional(),
  priority: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const assignmentRuleUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  assignmentType: z.enum(["assign_user", "round_robin"]).optional(),
  assignToUserId: z.string().nullable().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(conditionSchema).optional(),
  priority: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const assignmentReorderSchema = z.object({
  ruleIds: z.array(z.number().int().positive()),
});

export const scoringRuleCreateSchema = z.object({
  field: z.string().min(1),
  operator: scoringOperatorEnum,
  value: z.string().min(1),
  points: z.number().int().min(-1000).max(1000),
});

export const scoringRuleUpdateSchema = z.object({
  field: z.string().min(1).optional(),
  operator: scoringOperatorEnum.optional(),
  value: z.string().min(1).optional(),
  points: z.number().int().min(-1000).max(1000).optional(),
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

export type AssignmentRuleCreateInput = z.infer<typeof assignmentRuleCreateSchema>;
export type AssignmentRuleUpdateInput = z.infer<typeof assignmentRuleUpdateSchema>;
export type AssignmentReorderInput = z.infer<typeof assignmentReorderSchema>;
export type ScoringRuleCreateInput = z.infer<typeof scoringRuleCreateSchema>;
export type ScoringRuleUpdateInput = z.infer<typeof scoringRuleUpdateSchema>;
export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>;
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>;
