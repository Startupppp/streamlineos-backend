import { z } from "zod";

export const testAutomationRuleSchema = z.object({
  samplePayload: z.record(z.string(), z.unknown()),
}).strict();

export const createSequenceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  entityType: z.enum(["lead", "deal"]),
  isActive: z.boolean().default(true),
  stopOn: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export const updateSequenceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullish(),
  entityType: z.enum(["lead", "deal"]).optional(),
  isActive: z.boolean().optional(),
  stopOn: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export const createSequenceStepSchema = z.object({
  sortOrder: z.number().int().min(0),
  stepType: z.enum(["email", "call_task", "whatsapp_task", "wait"]),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  waitHours: z.number().int().min(0).nullable().optional(),
}).strict();

export const reorderSequenceStepsSchema = z.object({
  order: z.array(z.string().uuid()),
}).strict();

export const enrollInSequenceSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.string().min(1),
}).strict();

export type TestAutomationRuleInput = z.infer<typeof testAutomationRuleSchema>;
export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
export type CreateSequenceStepInput = z.infer<typeof createSequenceStepSchema>;
export type ReorderSequenceStepsInput = z.infer<typeof reorderSequenceStepsSchema>;
export type EnrollInSequenceInput = z.infer<typeof enrollInSequenceSchema>;

export const listEnrollmentsQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ListEnrollmentsQueryInput = z.infer<typeof listEnrollmentsQuerySchema>;
