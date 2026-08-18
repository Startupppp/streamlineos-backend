import { z } from "zod";

export const employeeExportFiltersSchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    departmentId: z.string().trim().min(1).max(255).optional(),
    isActive: z.enum(["true", "false", "all"]).default("true"),
    role: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const createEmployeeExportJobSchema = z
  .object({
    filters: employeeExportFiltersSchema.default({ isActive: "true" }),
  })
  .strict();

export const exportJobIdSchema = z.string().uuid();

export type EmployeeExportFiltersInput = z.infer<typeof employeeExportFiltersSchema>;
export type CreateEmployeeExportJobInput = z.infer<typeof createEmployeeExportJobSchema>;
