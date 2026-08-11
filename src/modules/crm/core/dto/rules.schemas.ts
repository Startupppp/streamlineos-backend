import { z } from "zod";

const conditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.string(),
});

const scoringOperatorEnum = z.enum(["eq", "gt", "lt", "contains", "in"]);

const extendedAssignmentTypeEnum = z.enum([
  "assign_user",
  "round_robin",
  "weighted_round_robin",
  "least_loaded",
  "territory",
]);

const configSchema = z.object({
  weights: z.record(z.string(), z.number()).optional(),
  leastLoadedWindowDays: z.number().int().positive().optional(),
  fallbackUserId: z.string().optional(),
}).optional().default({});

export const assignmentRuleCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  assignmentType: z.enum(["assign_user", "round_robin"]),
  assignToUserId: z.string().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(conditionSchema).optional(),
  priority: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  config: configSchema,
  assignmentTypeText: extendedAssignmentTypeEnum.optional(),
});

export const assignmentRuleUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  assignmentType: z.enum(["assign_user", "round_robin"]).optional(),
  assignToUserId: z.string().nullable().optional(),
  roundRobinUserIds: z.array(z.string()).optional(),
  conditions: z.array(conditionSchema).optional(),
  priority: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  config: z.object({
    weights: z.record(z.string(), z.number()).optional(),
    leastLoadedWindowDays: z.number().int().positive().optional(),
    fallbackUserId: z.string().optional(),
  }).optional(),
  assignmentTypeText: extendedAssignmentTypeEnum.optional(),
});

export const assignmentReorderSchema = z.object({
  ruleIds: z.array(z.number().int().positive()),
});

export const scoringRuleCreateSchema = z.object({
  field: z.string().min(1),
  operator: scoringOperatorEnum,
  value: z.string().min(1),
  points: z.number().int().min(-1000).max(1000),
}).strict();

export const scoringRuleUpdateSchema = z.object({
  field: z.string().min(1).optional(),
  operator: scoringOperatorEnum.optional(),
  value: z.string().min(1).optional(),
  points: z.number().int().min(-1000).max(1000).optional(),
}).strict();

export const emailTemplateCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
}).strict();

export const emailTemplateUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
}).strict();

const sampleLeadSchema = z.object({
  source: z.string().optional(),
  priority: z.string().optional(),
  score: z.number().optional(),
  language: z.string().optional(),
  city: z.string().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

export const assignmentPreviewSchema = z.object({
  sampleLead: sampleLeadSchema,
}).strict();

export type AssignmentRuleCreateInput = z.infer<typeof assignmentRuleCreateSchema>;
export type AssignmentRuleUpdateInput = z.infer<typeof assignmentRuleUpdateSchema>;
export type AssignmentReorderInput = z.infer<typeof assignmentReorderSchema>;
export type ScoringRuleCreateInput = z.infer<typeof scoringRuleCreateSchema>;
export type ScoringRuleUpdateInput = z.infer<typeof scoringRuleUpdateSchema>;
export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>;
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>;
export type AssignmentPreviewInput = z.infer<typeof assignmentPreviewSchema>;
export type SampleLeadForPreview = z.infer<typeof sampleLeadSchema>;
