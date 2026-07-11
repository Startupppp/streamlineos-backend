import { z } from "zod";

export const hrImportEntityValues = [
  "employees",
  "leave_balances",
  "attendance",
  "assets",
  "document_metadata",
] as const;

export type HrImportEntity = (typeof hrImportEntityValues)[number];

export const createImportJobSchema = z.object({
  entity: z.enum(hrImportEntityValues),
  fileName: z.string().min(1).max(255),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});
export type CreateImportJobInput = z.infer<typeof createImportJobSchema>;

export const listImportJobsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  entity: z.enum(hrImportEntityValues).optional(),
});
export type ListImportJobsInput = z.infer<typeof listImportJobsSchema>;

export const exportQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type ExportQueryInput = z.infer<typeof exportQuerySchema>;
