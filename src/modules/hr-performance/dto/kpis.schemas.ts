import { z } from "zod";

export const createKpiSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  unit: z.string().max(50).optional(),
  target: z.string().max(100).optional(),
  weight: z.string().max(50).optional(),
});
export type CreateKpiInput = z.infer<typeof createKpiSchema>;

export const updateKpiSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  unit: z.string().max(50).optional(),
  target: z.string().max(100).optional(),
  weight: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateKpiInput = z.infer<typeof updateKpiSchema>;

export const createFrameworkSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  ratingScale: z.number().int().min(2).max(10).optional(),
  levels: z
    .array(
      z.object({
        level: z.number().int().min(1),
        label: z.string().trim().min(1).max(100),
        description: z.string().max(1000),
      }),
    )
    .optional(),
});
export type CreateFrameworkInput = z.infer<typeof createFrameworkSchema>;

export const updateFrameworkSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  ratingScale: z.number().int().min(2).max(10).optional(),
  levels: z
    .array(
      z.object({
        level: z.number().int().min(1),
        label: z.string().trim().min(1).max(100),
        description: z.string().max(1000),
      }),
    )
    .optional(),
});
export type UpdateFrameworkInput = z.infer<typeof updateFrameworkSchema>;

export const createCompetencySchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  weight: z.string().max(50).optional(),
});
export type CreateCompetencyInput = z.infer<typeof createCompetencySchema>;
