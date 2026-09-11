import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const rowErrorSchema = z.object({
  row: z.number().int(),
  field: z.string(),
  message: z.string(),
});

const jobErrorSchema = z.object({
  row: z.number().int(),
  field: z.string(),
  message: z.string(),
});

const exportJobSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobType: z.string(),
  status: z.string(),
  fileName: z.string().nullable(),
  totalRows: z.number().int(),
  processedRows: z.number().int(),
  errorRows: z.number().int(),
  errors: z.array(jobErrorSchema).nullable(),
  resultUrl: z.undefined().optional(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const importJobSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobType: z.string(),
  status: z.string(),
  fileName: z.string().nullable(),
  totalRows: z.number().int(),
  processedRows: z.number().int(),
  errorRows: z.number().int(),
  errors: z.array(jobErrorSchema).nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createExportJobResponseSchema = exportJobSchema;

export const listExportJobsResponseSchema = itemsPagedSchema(exportJobSchema);

export const importPreviewResponseSchema = z.object({
  importType: z.string(),
  columns: z.array(z.string()),
  mappedFields: z.array(z.string()),
  validRows: z.number().int(),
  errors: z.array(rowErrorSchema),
  sample: z.array(z.record(z.string(), z.unknown())),
});

export const createImportJobResponseSchema = importJobSchema;

export const listImportJobsResponseSchema = itemsPagedSchema(importJobSchema);

/**
 * INV-108 — the staged import's own shapes.
 *
 * `openStaged` returns the whole `inv_import_jobs` row, not a projection. The
 * `errors` column is untyped `jsonb` on that table, so it is deliberately left
 * undeclared here rather than asserted to be an array of row errors: a schema
 * that guessed it would be a schema that turns a green suite red the first time
 * a job stores something else there.
 */
export const openStagedImportJobResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobType: z.string(),
  status: z.string(),
  fileName: z.string().nullable(),
  totalRows: z.number().int(),
  processedRows: z.number().int(),
  errorRows: z.number().int(),
  resultUrl: z.string().nullable(),
  checksum: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  chunkSize: z.number().int(),
  nextRow: z.number().int(),
  stagedRows: z.number().int(),
  cancelledAt: nullableWireDate(),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** What staging a chunk reports: the file's size, and how much of it has landed. */
export const stageImportRowsResponseSchema = z.object({
  jobId: z.number().int(),
  stagedRows: z.number().int(),
  totalRows: z.number().int(),
});

/**
 * `progressOf` — the resume loop's answer, returned by `process`, `cancel` and
 * the progress read alike. `chunk` carries the per-row outcomes only on the
 * call that produced them; every other caller sees null.
 */
export const stagedImportProgressResponseSchema = z.object({
  jobId: z.number().int(),
  status: z.string(),
  importType: z.string(),
  totalRows: z.number().int(),
  stagedRows: z.number().int(),
  appliedRows: z.number().int(),
  failedRows: z.number().int(),
  nextRow: z.number().int(),
  cancelled: z.boolean(),
  finished: z.boolean(),
  chunk: z.array(z.object({
    rowNumber: z.number().int(),
    status: z.enum(["APPLIED", "FAILED", "SKIPPED"]),
    code: z.string().optional(),
    field: z.string().optional(),
    message: z.string().optional(),
  })).nullable(),
});

/**
 * Row-level failures, paginated — a 100k import can fail 100k times, and a
 * single unbounded list of them is not something a screen can render.
 */
export const stagedImportErrorsResponseSchema = itemsPagedSchema(
  z.object({
    rowNumber: z.number().int(),
    code: z.string().nullable(),
    field: z.string().nullable(),
    message: z.string().nullable(),
  }),
);
