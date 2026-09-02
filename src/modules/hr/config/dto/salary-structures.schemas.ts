import { z } from "zod";

export const salaryStructureListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
}).strict();

export const createSalaryStructureSchema = z.object({
  userId: z.string(),
  basicSalary: z.number(),
  hraPercentage: z.number(),
  allowances: z.number(),
  deductions: z.number(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().optional(),
}).strict();

export type SalaryStructureListQuery = z.infer<typeof salaryStructureListQuerySchema>;
export type CreateSalaryStructureInput = z.infer<typeof createSalaryStructureSchema>;
