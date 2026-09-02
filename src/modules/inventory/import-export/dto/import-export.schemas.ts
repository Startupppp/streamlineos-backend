import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
﻿import { z } from "zod";

const IMPORT_TYPES = ["products", "vendors", "categories", "uom", "locations", "opening-stock", "reorder-rules"] as const;
export type ImportType = typeof IMPORT_TYPES[number];

const EXPORT_TYPES = ["products", "stock", "movements", "reorder", "valuation", "lots-serials"] as const;
export type ExportType = typeof EXPORT_TYPES[number];

export const previewImportSchema = z.object({
  importType: z.enum(IMPORT_TYPES),
}).strict();
export type PreviewImportInput = z.infer<typeof previewImportSchema>;

export const createImportJobSchema = z.object({
  importType: z.enum(IMPORT_TYPES),
  rows: z.array(z.record(z.string(), z.string())).min(1).max(10000),
}).strict();
export type CreateImportJobInput = z.infer<typeof createImportJobSchema>;

export const listJobsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();
export type ListJobsQueryInput = z.infer<typeof listJobsQuerySchema>;

export const createExportJobSchema = z.object({
  exportType: z.enum(EXPORT_TYPES),
  filters: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();
export type CreateExportJobInput = z.infer<typeof createExportJobSchema>;
