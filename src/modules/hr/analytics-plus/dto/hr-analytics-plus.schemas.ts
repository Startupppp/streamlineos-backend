import { z } from "zod";
import {
  optionalPageNumberField,
  optionalPageSizeField,
} from "../../../../common/pagination/list-query.schema";

export const departmentQuerySchema = z.object({
  departmentId: z.string().uuid().optional(),
});

export const cycleQuerySchema = z.object({
  cycleId: z.coerce.number().int().positive().optional(),
});

export const drilldownQuerySchema = z.object({
  metric: z.enum(["attrition", "leave", "attendance", "cases"]),
  page: optionalPageNumberField(),
  limit: optionalPageSizeField(100),
  departmentId: z.string().uuid().optional(),
});

export const headcountPlanSchema = z.object({
  fiscalYear: z.number().int().min(2020).max(2050),
  departmentId: z.string().uuid().optional(),
  budgetedHeadcount: z.number().int().positive(),
  budgetedCostCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

export const updateHeadcountPlanSchema = headcountPlanSchema
  .partial()
  .omit({ fiscalYear: true });

export type DepartmentQuery = z.infer<typeof departmentQuerySchema>;
export type CycleQuery = z.infer<typeof cycleQuerySchema>;
export type DrilldownQuery = z.infer<typeof drilldownQuerySchema>;
export type HeadcountPlanInput = z.infer<typeof headcountPlanSchema>;
export type UpdateHeadcountPlanInput = z.infer<typeof updateHeadcountPlanSchema>;
