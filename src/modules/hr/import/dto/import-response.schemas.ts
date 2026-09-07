import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const cursorPagination = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const importErrorSchema = z.object({
  row: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
});

export const hrImportJobRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  entity: z.string(),
  fileName: z.string(),
  status: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  errors: z.array(importErrorSchema).nullable(),
  createdBy: z.string().nullable(),
  committedAt: nullableWireDate(),
  rolledBackAt: nullableWireDate(),
  createdAt: wireDate(),
});

const hrImportRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  jobId: z.string(),
  rowNumber: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  status: z.string(),
  error: z.string().nullable(),
  createdRecordRef: z.unknown().nullable(),
});

export const hrImportJobCreateResultSchema = z.object({
  job: hrImportJobRowSchema,
  summary: z.object({
    total: z.number().int(),
    valid: z.number().int(),
    errors: z.number().int(),
    topErrors: z.array(importErrorSchema),
  }),
});

export const hrImportJobListSchema = z.object({
  data: z.array(hrImportJobRowSchema),
  total: z.number().int(),
  pagination: cursorPagination,
});

export const hrImportJobDetailSchema = z.object({
  job: hrImportJobRowSchema,
  errorRows: z.array(hrImportRowSchema),
});

export const hrExportJobViewSchema = z.object({
  id: z.string(),
  entity: z.string(),
  status: z.string(),
  processedRows: z.number().int(),
  rowCount: z.number().int().nullable(),
  fileName: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  completedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
});
