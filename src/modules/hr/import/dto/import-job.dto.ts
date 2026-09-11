import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

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
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  entity: z.enum(hrImportEntityValues).optional(),
});
export type ListImportJobsInput = z.infer<typeof listImportJobsSchema>;

export const exportQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(100, 100),
  })
  .strict();
export type ExportQueryInput = z.infer<typeof exportQuerySchema>;
