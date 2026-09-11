import { z } from "zod";
import { aiUsageMetaSchema, invAiProvenanceSchema } from "../../dto/inv-ai-wire.schemas";
import { invReportSpecSchema } from "./inv-report-spec.schemas";

/** `InvReportCell` — a projected column, never a nested object. */
const reportCellSchema = z.union([z.string(), z.number(), z.null()]);

const reportColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  numeric: z.boolean(),
});

/**
 * `InvReportPreview` (`inv-report-builder.service.ts`).
 *
 * `spec` is the request schema itself, on purpose: the spec the preview returns
 * is the one the client hands straight back to `export`, and the two describing
 * the same object differently is precisely how the second request would stop
 * producing the first one's report.
 */
export const invReportAskResponseSchema = z.object({
  status: z.enum(["ok", "not_permitted"]),
  question: z.string(),
  spec: invReportSpecSchema,
  label: z.string(),
  plannedBy: z.enum(["model", "deterministic"]),
  columns: z.array(reportColumnSchema),
  rows: z.array(z.record(z.string(), reportCellSchema)),
  rowCount: z.number().int(),
  total: z.number().int().nullable(),
  truncated: z.boolean(),
  stripped: z.array(z.object({ field: z.string(), reason: z.string() })),
  requiredPermission: z.string().nullable(),
  canExport: z.boolean(),
  provenance: invAiProvenanceSchema.nullable(),
  aiUsage: aiUsageMetaSchema.optional(),
  generatedAt: z.string(),
});

/**
 * The catalogue the ask box offers as buttons. `prompt` is the same text the
 * model is shown, so the two cannot disagree.
 */
export const invReportCatalogResponseSchema = z.object({
  reports: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      viewPermission: z.string(),
      exportPermission: z.string(),
      takesWarehouse: z.boolean(),
      columns: z.array(reportColumnSchema),
    }),
  ),
  prompt: z.string(),
});
