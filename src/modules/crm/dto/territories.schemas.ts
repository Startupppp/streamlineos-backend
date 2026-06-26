import { z } from "zod";

export const territoryListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const territoryCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  states: z.array(z.string()).optional().default([]),
  cities: z.array(z.string()).optional().default([]),
  assignedReps: z.array(z.number()).optional().default([]),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

export const territoryUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  states: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  assignedReps: z.array(z.number()).optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export type TerritoryListInput = z.infer<typeof territoryListSchema>;
export type TerritoryCreateInput = z.infer<typeof territoryCreateSchema>;
export type TerritoryUpdateInput = z.infer<typeof territoryUpdateSchema>;
