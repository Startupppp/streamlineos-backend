import { z } from "zod";

const appliesToEnum = z.enum(["lead", "deal", "both"]);
const priorityEnum = z.enum(["low", "medium", "high", "urgent"]);

export const slaPolicyCreateSchema = z.object({
  name: z.string().min(1),
  appliesTo: appliesToEnum,
  priority: priorityEnum,
  firstResponseHours: z.number().int().positive(),
  resolutionHours: z.number().int().positive(),
});

export const slaPolicyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  appliesTo: appliesToEnum.optional(),
  priority: priorityEnum.optional(),
  firstResponseHours: z.number().int().positive().optional(),
  resolutionHours: z.number().int().positive().optional(),
});

export type SlaPolicyCreateInput = z.infer<typeof slaPolicyCreateSchema>;
export type SlaPolicyUpdateInput = z.infer<typeof slaPolicyUpdateSchema>;
