import { z } from "zod";
import { EXPORT_MAX_ROWS, IMPORT_MAX_CONTENT_BYTES } from "../import-export.constants";

export const importExportProjectParams = z
  .object({ projectId: z.coerce.number().int().positive() })
  .strict();

export const importFormatSchema = z.enum(["csv", "json"]);

export const importModeSchema = z.enum(["atomic", "partial"]);

const importContentSchema = z
  .string()
  .min(1, "The file is empty")
  .max(IMPORT_MAX_CONTENT_BYTES, `The file is larger than ${IMPORT_MAX_CONTENT_BYTES} bytes`);

export const previewTicketImportSchema = z
  .object({
    format: importFormatSchema,
    content: importContentSchema,
  })
  .strict();

export const commitTicketImportSchema = z
  .object({
    format: importFormatSchema,
    content: importContentSchema,
    confirmationToken: z.string().min(1).max(200),
    mode: importModeSchema.optional(),
  })
  .strict();

export const exportTicketsQuerySchema = z
  .object({
    format: importFormatSchema,
    limit: z.coerce.number().int().min(1).max(EXPORT_MAX_ROWS).optional(),
  })
  .strict();

export type PreviewTicketImportInput = z.infer<typeof previewTicketImportSchema>;

export type CommitTicketImportInput = z.infer<typeof commitTicketImportSchema>;

export type ExportTicketsQuery = z.infer<typeof exportTicketsQuerySchema>;
