import { z } from "zod";

export const createValidationRuleSchema = z.object({
  entityType: z.enum(["lead", "deal", "contact", "company", "quote"]),
  field: z.string().min(1).max(100),
  ruleType: z.enum([
    "required", "email", "phone", "url", "regex",
    "numeric_min", "numeric_max", "currency_min", "currency_max",
    "date_not_past", "date_not_future", "unique",
    "conditional_required", "stage_required", "source_required",
  ]),
  config: z.record(z.string(), z.unknown()).default({}),
  pipelineId: z.string().optional(),
  stageKey: z.string().optional(),
  sourceKey: z.string().optional(),
  errorMessage: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
}).strict();
export type CreateValidationRuleInput = z.infer<typeof createValidationRuleSchema>;

export const updateValidationRuleSchema = createValidationRuleSchema.partial().strict();
export type UpdateValidationRuleInput = z.infer<typeof updateValidationRuleSchema>;

export const testValidationSchema = z.object({
  entityType: z.enum(["lead", "deal", "contact", "company", "quote"]),
  record: z.record(z.string(), z.unknown()),
  pipelineId: z.string().optional(),
  stageKey: z.string().optional(),
  sourceKey: z.string().optional(),
  existingRecordId: z.union([z.string(), z.number()]).optional(),
}).strict();
export type TestValidationInput = z.infer<typeof testValidationSchema>;
