import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { z } from "zod";

const IMPORT_TYPES = ["products", "vendors", "categories", "uom", "locations", "opening-stock", "reorder-rules"] as const;
export type ImportType = typeof IMPORT_TYPES[number];

const IMPORT_TYPE_SET: ReadonlySet<string> = new Set(IMPORT_TYPES);

/**
 * `inv_import_jobs.job_type` is a bare `text` column, so a job read back from
 * the database hands out a `string`. Asserting it into `ImportType` at the use
 * site would make `EXPECTED_COLUMNS[importType]` silently `undefined` for a
 * value written by an older release or by hand; this narrows instead, so the
 * unrecognised value is a refusal that names itself.
 */
export function isImportType(value: string): value is ImportType {
  return IMPORT_TYPE_SET.has(value);
}

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

/** INV-108 staged import: a job is opened, rows are staged, then processed. */
export const openImportJobSchema = z.object({
  importType: z.enum(IMPORT_TYPES),
  fileName: z.string().max(255).optional(),
  /** Rows in the whole file, so progress can be reported before staging finishes. */
  totalRows: z.number().int().min(1).max(1_000_000),
  /** Of the file's bytes. A key reused with a different checksum is refused. */
  checksum: z.string().min(8).max(128),
  chunkSize: z.number().int().min(1).max(1000).optional(),
}).strict();
export type OpenImportJobInput = z.infer<typeof openImportJobSchema>;

export const stageImportRowsSchema = z.object({
  rows: z.array(z.object({
    /** Position in the file, 1-based, so an error cites the line a human sees. */
    rowNumber: z.number().int().min(1),
    payload: z.record(z.string(), z.string()),
  }).strict()).min(1).max(5000),
}).strict();
export type StageImportRowsInput = z.infer<typeof stageImportRowsSchema>;

export const importErrorsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ImportErrorsQueryInput = z.infer<typeof importErrorsQuerySchema>;
