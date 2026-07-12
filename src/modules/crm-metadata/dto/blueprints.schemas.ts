import { z } from "zod";

export const createBlueprintSchema = z.object({
  pipelineId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
}).strict();
export type CreateBlueprintInput = z.infer<typeof createBlueprintSchema>;

export const updateBlueprintSchema = createBlueprintSchema.partial().omit({ pipelineId: true }).strict();
export type UpdateBlueprintInput = z.infer<typeof updateBlueprintSchema>;

export const createTransitionSchema = z.object({
  fromStageKey: z.string().min(1),
  toStageKey: z.string().min(1),
  requiredFields: z.array(z.string()).default([]),
  requiredActivityTypeKeys: z.array(z.string()).default([]),
  requiresApproval: z.boolean().default(false),
  requiresQuote: z.boolean().default(false),
  autoTaskTemplates: z.array(z.record(z.string(), z.unknown())).default([]),
  sortOrder: z.number().int().min(0).default(0),
}).strict();
export type CreateTransitionInput = z.infer<typeof createTransitionSchema>;

export const testTransitionSchema = z.object({
  fromStageKey: z.string().min(1),
  toStageKey: z.string().min(1),
  record: z.record(z.string(), z.unknown()),
}).strict();
export type TestTransitionInput = z.infer<typeof testTransitionSchema>;
