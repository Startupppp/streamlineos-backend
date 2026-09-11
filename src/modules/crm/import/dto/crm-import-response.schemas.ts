import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { EXPORT_ENTITIES } from "../crm-export.service";

export const importProgressSchema = z.object({
  crmImportId: z.string(),
  status: z.string(),
  workflowRunId: z.string().nullable(),
  runStatus: z.string().nullable(),
  complete: z.boolean(),
  total: z.number().int(),
  remaining: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  merged: z.number().int(),
  review: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  reverted: z.number().int(),
  revertDeadlineAt: nullableWireDate(),
});

export const connectorProgressSchema = z.object({
  crmConnectorSyncId: z.string(),
  provider: z.string(),
  stream: z.string(),
  enabled: z.boolean(),
  syncedThrough: z.string().nullable(),
  resuming: z.boolean(),
  staged: z.number().int(),
  crmImportId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
});

const columnMappingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mapped"), field: z.string(), confidence: z.number() }),
  z.object({ kind: z.literal("custom"), key: z.string() }),
  z.object({ kind: z.literal("ambiguous"), candidates: z.array(z.string()) }),
  z.object({ kind: z.literal("unmapped") }),
]);

const mappedColumnSchema = z.object({
  header: z.string(),
  mapping: columnMappingSchema,
});

const importSummarySchema = z.object({
  create: z.number().int(),
  update: z.number().int(),
  merge: z.number().int(),
  review: z.number().int(),
  skip: z.number().int(),
  total: z.number().int(),
});

const plannedRowSchema = z.object({
  rowNumber: z.number().int(),
  action: z.enum(["create", "update", "merge", "review", "skip"]),
  reason: z.string(),
  values: z.record(z.string(), z.string()),
  customFields: z.record(z.string(), z.string()),
  matchedRecordId: z.string().optional(),
  duplicateOfRow: z.number().int().optional(),
  match: z
    .object({
      score: z.number(),
      signals: z.array(z.string()),
      candidateName: z.string().optional(),
    })
    .optional(),
});

export const importPreviewSchema = z.object({
  crmImportId: z.string(),
  entity: z.enum(["party", "subject", "pipeline", "activity"]),
  subjectTypeId: z.string().nullable(),
  columns: z.array(mappedColumnSchema),
  needsConfirmation: z.array(mappedColumnSchema),
  summary: importSummarySchema,
  warnings: z.array(z.string()),
  rows: z.array(plannedRowSchema),
});

export const importRowSchema = z.object({
  crmImportRowId: z.string(),
  organizationId: z.string(),
  crmImportId: z.string(),
  rowNumber: z.number().int(),
  action: z.string(),
  reason: z.string().nullable(),
  values: z.record(z.string(), z.unknown()).nullable(),
  customFields: z.record(z.string(), z.unknown()).nullable(),
  matchedRecordId: z.string().nullable(),
  duplicateOfRow: z.number().int().nullable(),
  match: z.unknown().nullable(),
});

export const importRecordSchema = z.object({
  crmImportId: z.string(),
  organizationId: z.string(),
  status: z.string(),
  sourceFilename: z.string().nullable(),
  targetEntity: z.string(),
  targetSubjectTypeId: z.string().nullable(),
  columns: z.unknown().nullable(),
  summary: z.unknown().nullable(),
  workflowRunId: z.string().nullable(),
  revertWorkflowRunId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  committedAt: nullableWireDate(),
  revertDeadlineAt: nullableWireDate(),
  revertedAt: nullableWireDate(),
  revertedByUserId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  rows: z.array(importRowSchema),
});

/**
 * The archive download is written straight to the response as one JSON document,
 * so it carries no `@ResponseSchema`. Row shapes come from a raw-SQL projection
 * per entity and differ between them; the entity keys are the contract.
 */
export const crmArchiveDownloadSchema = {
  type: "object",
  properties: Object.fromEntries(
    EXPORT_ENTITIES.map((entity) => [
      entity,
      { type: "array", items: { type: "object", additionalProperties: true } },
    ]),
  ),
  required: [...EXPORT_ENTITIES],
  additionalProperties: false,
};
