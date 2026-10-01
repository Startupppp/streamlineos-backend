import { z } from "zod";
import { importFormatSchema, importModeSchema } from "./import-export-request.schemas";
import { DB_ENUMS } from "../../../../db/enums.generated";

export const importIssueKindSchema = z.enum([
  "INVALID",
  "DUPLICATE_IN_FILE",
  "DUPLICATE_EXISTING",
]);

export const importRowOutcomeSchema = z.enum([
  "IMPORTED",
  "SKIPPED",
  "FAILED",
  "ROLLED_BACK",
]);

const ticketTypeSchema = z.enum(DB_ENUMS.ticket_type);

const ticketPrioritySchema = z.enum(DB_ENUMS.ticket_priority);

export const importRowIssueSchema = z.object({
  rowNumber: z.number().int(),
  field: z.string().nullable(),
  kind: importIssueKindSchema,
  message: z.string(),
});

export const importPreviewValuesSchema = z.object({
  title: z.string(),
  status: z.string(),
  description: z.string().nullish(),
  type: ticketTypeSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  startDate: z.string().nullish(),
  dueDate: z.string().nullish(),
  points: z.number().int().nullish(),
  storyPoints: z.number().int().nullish(),
  estimate: z.number().int().nullish(),
  completionPercentage: z.number().int().optional(),
  clientVisible: z.boolean().optional(),
  link: z.string().nullish(),
});

export const importPreviewRowSchema = z.object({
  rowNumber: z.number().int(),
  values: importPreviewValuesSchema,
});

export const importPreviewSchema = z.object({
  format: importFormatSchema,
  projectId: z.number().int(),
  fileError: z.string().nullable(),
  summary: z.object({
    totalRows: z.number().int(),
    importable: z.number().int(),
    invalid: z.number().int(),
    duplicateInFile: z.number().int(),
    duplicateExisting: z.number().int(),
  }),
  rows: z.array(importPreviewRowSchema),
  issues: z.array(importRowIssueSchema),
  confirmationToken: z.string().nullable(),
});

export const importRowResultSchema = z.object({
  rowNumber: z.number().int(),
  outcome: importRowOutcomeSchema,
  ticketId: z.number().int().nullable(),
  message: z.string().nullable(),
});

export const importReportSchema = z.object({
  projectId: z.number().int(),
  format: importFormatSchema,
  mode: importModeSchema,
  idempotencyKey: z.string().nullable(),
  replayed: z.boolean(),
  confirmationToken: z.string(),
  summary: z.object({
    attempted: z.number().int(),
    imported: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    rolledBack: z.number().int(),
  }),
  rows: z.array(importRowResultSchema),
  issues: z.array(importRowIssueSchema),
});

export const ticketExportSchema = z.object({
  format: importFormatSchema,
  filename: z.string(),
  contentType: z.string(),
  rowCount: z.number().int(),
  content: z.string(),
});
