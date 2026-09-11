import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const signBulkSendJobRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  status: z.enum(["pending", "validating", "running", "completed", "failed", "cancelled"]),
  columnMappingJson: z.record(z.string(), z.string()),
  totalCount: z.number().int(),
  successCount: z.number().int(),
  failedCount: z.number().int(),
  csvFileKey: z.string().nullable(),
  errorReportFileKey: z.string().nullable(),
  createdAt: wireDate(),
  completedAt: nullableWireDate(),
});

const signBulkSendRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobId: z.number().int(),
  rowNumber: z.number().int(),
  rawDataJson: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "success", "failed"]),
  envelopeId: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createBulkJobResponseSchema = z.object({
  job: signBulkSendJobRowSchema,
  dryRun: z.boolean(),
  preview: z.unknown().optional(),
});

export const listBulkJobsResponseSchema = z.array(signBulkSendJobRowSchema);

export const getBulkJobResponseSchema = z.object({
  job: signBulkSendJobRowSchema,
  rows: z.array(signBulkSendRowSchema),
});

export const cancelBulkJobResponseSchema = signBulkSendJobRowSchema;

export const bulkJobErrorReportResponseSchema = z.array(signBulkSendRowSchema);
