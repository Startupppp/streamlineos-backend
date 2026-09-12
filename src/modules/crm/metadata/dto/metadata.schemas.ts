import { z } from "zod";

const keyRegex = /^[a-z0-9_.:-]+$/;

export const createPipelineSchema = z.object({
  type: z.enum(["lead", "deal", "renewal", "customer_success", "partner", "custom"]).default("custom"),
  key: z.string().min(1).max(100).regex(keyRegex),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
}).strict();
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = createPipelineSchema.partial().strict();
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;

export const createStageSchema = z.object({
  key: z.string().min(1).max(100).regex(keyRegex),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  sortOrder: z.number().int().min(0).default(0),
  probability: z.number().int().min(0).max(100).default(0),
  stageType: z.enum(["open", "won", "lost", "archived"]).default("open"),
  isTerminal: z.boolean().default(false),
  slaHours: z.number().int().min(0).nullable().optional(),
  requiresApproval: z.boolean().default(false),
  requiredFields: z.array(z.string()).default([]),
  allowedNextStageKeys: z.array(z.string()).nullable().default(null),
  isActive: z.boolean().default(true),
}).strict();
export type CreateStageInput = z.infer<typeof createStageSchema>;

export const updateStageSchema = createStageSchema.partial().strict();
export type UpdateStageInput = z.infer<typeof updateStageSchema>;

/**
 * One `UPDATE` per id inside a `Promise.all` in `reorderStages`, so the list is
 * a concurrent-statement count the caller sets. A pipeline is a handful of
 * stages; 100 is the same bound `listOptions` and the stage reads already carry,
 * and no real pipeline approaches it.
 */
const STAGE_REORDER_MAX = 100;

export const reorderStagesSchema = z.object({
  stageIds: z.array(z.string()).min(1).max(STAGE_REORDER_MAX),
}).strict();
export type ReorderStagesInput = z.infer<typeof reorderStagesSchema>;

const OPTION_TYPES = [
  "lead_status", "priority", "source", "lost_reason",
  "activity_type", "competitor", "forecast_category", "task_type", "contact_role",
] as const;
export const optionTypeSchema = z.enum(OPTION_TYPES);

export const createOptionSchema = z.object({
  key: z.string().min(1).max(100).regex(keyRegex),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  isSystemDefault: z.boolean().default(false),
  isTerminal: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CreateOptionInput = z.infer<typeof createOptionSchema>;

export const updateOptionSchema = createOptionSchema.partial().strict();
export type UpdateOptionInput = z.infer<typeof updateOptionSchema>;

export const listPipelinesSchema = z.object({
  type: z.enum(["lead", "deal", "renewal", "customer_success", "partner", "custom"]).optional(),
}).strict();
