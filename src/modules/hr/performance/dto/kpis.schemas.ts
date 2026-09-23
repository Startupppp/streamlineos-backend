import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { decimalString } from "../../../../common/validation/decimal-string.schema";

export const createKpiSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "KPI name is required")
    .max(200, "KPI name must be at most 200 characters"),
  category: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(100, "Category must be at most 100 characters"),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  unit: z.string().trim().max(50, "Unit must be at most 50 characters").optional(),
  target: decimalString.optional(),
  weight: decimalString.optional(),
}).strict();

export const updateKpiSchema = z.object({
  name: z.string().trim().min(1).max(200, "KPI name must be at most 200 characters").optional(),
  category: z.string().trim().min(1).max(100, "Category must be at most 100 characters").optional(),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  unit: z.string().trim().max(50, "Unit must be at most 50 characters").optional(),
  target: decimalString.optional(),
  weight: decimalString.optional(),
  isActive: z.boolean().optional(),
}).strict();

const competencyLevelSchema = z.object({
  level: z.coerce.number().int().positive(),
  label: z.string().trim().min(1, "Level label is required").max(100, "Level label must be at most 100 characters"),
  description: z.string().trim().max(500, "Level description must be at most 500 characters").optional().default(""),
});

export const createFrameworkSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Framework name is required")
    .max(200, "Framework name must be at most 200 characters"),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  ratingScale: z.coerce.number().int().min(2, "Rating scale must be at least 2").max(10, "Rating scale must be at most 10").optional(),
  levels: z.array(competencyLevelSchema).max(20, "At most 20 levels are allowed").optional(),
}).strict();

export const updateFrameworkSchema = z.object({
  name: z.string().trim().min(1).max(200, "Framework name must be at most 200 characters").optional(),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  ratingScale: z.coerce.number().int().min(2, "Rating scale must be at least 2").max(10, "Rating scale must be at most 10").optional(),
  levels: z.array(competencyLevelSchema).max(20, "At most 20 levels are allowed").optional(),
}).strict();

export const createCompetencySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Competency name is required")
    .max(200, "Competency name must be at most 200 characters"),
  category: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(100, "Category must be at most 100 characters"),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  weight: decimalString.optional(),
}).strict();

export type CreateKpiInput = z.infer<typeof createKpiSchema>;
export type UpdateKpiInput = z.infer<typeof updateKpiSchema>;
export type CreateFrameworkInput = z.infer<typeof createFrameworkSchema>;
export type UpdateFrameworkInput = z.infer<typeof updateFrameworkSchema>;
export type CreateCompetencyInput = z.infer<typeof createCompetencySchema>;

export const listCompetenciesSchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(50, 100),
}).strict();
export type ListCompetenciesInput = z.infer<typeof listCompetenciesSchema>;
