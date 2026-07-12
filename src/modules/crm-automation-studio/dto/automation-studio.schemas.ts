import { z } from "zod";

export const testAutomationRuleSchema = z.object({
  samplePayload: z.record(z.string(), z.unknown()),
});

export const createSequenceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  entityType: z.enum(["lead", "deal"]),
  isActive: z.boolean().default(true),
  stopOn: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const updateSequenceSchema = createSequenceSchema.partial();

export const createSequenceStepSchema = z.object({
  sortOrder: z.number().int().min(0),
  stepType: z.enum(["email", "call_task", "whatsapp_task", "wait"]),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  waitHours: z.number().int().min(0).nullable().optional(),
});

export const reorderSequenceStepsSchema = z.object({
  order: z.array(z.string().uuid()),
});

export const enrollInSequenceSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.string().min(1),
});

export type TestAutomationRuleInput = z.infer<typeof testAutomationRuleSchema>;
export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
export type CreateSequenceStepInput = z.infer<typeof createSequenceStepSchema>;
export type ReorderSequenceStepsInput = z.infer<typeof reorderSequenceStepsSchema>;
export type EnrollInSequenceInput = z.infer<typeof enrollInSequenceSchema>;
