import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createPositionSchema = z.object({
  title: z.string().min(1).max(300),
  departmentId: z.string().uuid().optional(),
  jobLevelId: z.number().int().positive().optional(),
  status: z.string().min(1).max(100),
  budgetedCostCents: z.number().int().positive().optional(),
  effectiveFrom: z.string().min(1),
  incumbentUserId: z.string().optional(),
  futureDated: z.boolean().optional(),
});

export const updatePositionSchema = createPositionSchema.partial();

export const listPositionsSchema = paginationSchema.extend({
  status: z.string().min(1).max(100).optional(),
  departmentId: z.string().uuid().optional(),
});

export const assignPositionSchema = z.object({
  incumbentUserId: z.string().min(1),
});

export const createReorgScenarioSchema = z.object({
  name: z.string().min(1).max(300),
  changes: z.record(z.string(), z.unknown()),
});

export const updateReorgScenarioSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  status: z.enum(["draft", "proposed", "applied"]).optional(),
  changes: z.record(z.string(), z.unknown()).optional(),
});

export const listScenariosSchema = paginationSchema.extend({
  status: z.enum(["draft", "proposed", "applied"]).optional(),
});

export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;
export type ListPositionsInput = z.infer<typeof listPositionsSchema>;
export type AssignPositionInput = z.infer<typeof assignPositionSchema>;
export type CreateReorgScenarioInput = z.infer<typeof createReorgScenarioSchema>;
export type UpdateReorgScenarioInput = z.infer<typeof updateReorgScenarioSchema>;
export type ListScenariosInput = z.infer<typeof listScenariosSchema>;
