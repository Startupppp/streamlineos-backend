import { z } from "zod";

const appliesToEnum = z.enum(["lead", "deal", "both"]);
const priorityEnum = z.enum(["low", "medium", "high", "urgent"]);

const conditionsSchema = z.object({
  sourceKeys: z.array(z.string()).optional(),
  priorityKeys: z.array(z.string()).optional(),
  scoreMin: z.number().optional(),
  scoreMax: z.number().optional(),
  territoryIds: z.array(z.number().int()).optional(),
  segment: z.string().optional(),
  appliesToText: z.string().optional(),
}).optional().default({});

export const slaPolicyCreateSchema = z.object({
  name: z.string().min(1),
  appliesTo: appliesToEnum,
  priority: priorityEnum,
  firstResponseHours: z.number().int().positive(),
  resolutionHours: z.number().int().positive(),
  conditions: conditionsSchema,
  targetMinutes: z.number().int().positive().optional(),
  businessHours: z.boolean().optional().default(false),
  appliesToText: z.string().optional(),
  priorityText: z.string().optional(),
});

export const slaPolicyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  appliesTo: appliesToEnum.optional(),
  priority: priorityEnum.optional(),
  firstResponseHours: z.number().int().positive().optional(),
  resolutionHours: z.number().int().positive().optional(),
  conditions: z.object({
    sourceKeys: z.array(z.string()).optional(),
    priorityKeys: z.array(z.string()).optional(),
    scoreMin: z.number().optional(),
    scoreMax: z.number().optional(),
    territoryIds: z.array(z.number().int()).optional(),
    segment: z.string().optional(),
    appliesToText: z.string().optional(),
  }).optional(),
  targetMinutes: z.number().int().positive().optional(),
  businessHours: z.boolean().optional(),
  appliesToText: z.string().optional(),
  priorityText: z.string().optional(),
});

export type SlaPolicyCreateInput = z.infer<typeof slaPolicyCreateSchema>;
export type SlaPolicyUpdateInput = z.infer<typeof slaPolicyUpdateSchema>;
