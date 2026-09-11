import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
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
