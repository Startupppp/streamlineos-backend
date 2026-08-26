import { z } from "zod";
import { IMPORT_FIELDS } from "../column-mapping";
import { CONNECTOR_PROVIDERS, CONNECTOR_STREAMS } from "../connectors/connector-source";
import { EXPORT_ENTITIES } from "../crm-export.service";

/** A paste, not a migration. The direct connectors are Phase 2. */
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 100;
const MAX_CELL = 5_000;

export const previewImportSchema = z
  .object({
    filename: z.string().max(255).optional(),
    headers: z.array(z.string().max(200)).min(1).max(MAX_COLUMNS),
    rows: z
      .array(z.array(z.string().max(MAX_CELL)).max(MAX_COLUMNS))
      .max(MAX_ROWS),
    /**
     * A person's answers to ambiguous columns, keyed by header.
     *
     * `__ignore__` is an answer too — "this column is not for you" is a
     * decision, and treating it as unanswered would ask again forever.
     */
    overrides: z
      .record(z.string().max(200), z.enum([...IMPORT_FIELDS, "__ignore__"]))
      .optional(),
  })
  .strict();

export type PreviewImportInput = z.infer<typeof previewImportSchema>;

export const exportQuerySchema = z
  .object({
    entity: z.enum([...EXPORT_ENTITIES] as [string, ...string[]]),
    format: z.enum(["csv", "json"]).default("csv"),
  })
  .strict();

export type ExportQuery = z.infer<typeof exportQuerySchema>;

/**
 * Which connected account to read, and which of its collections.
 *
 * Both enums come from `connector-source` rather than being spelled again here.
 * A second copy is how `IntegrationToolkit` ended up existing three times in
 * three shapes, only two of which a compiler can keep in step.
 */
export const connectorSyncSchema = z
  .object({
    /** The `user_integration_connections` row, which is a `serial`. */
    connectionId: z.number().int().positive(),
    provider: z.enum([...CONNECTOR_PROVIDERS] as [string, ...string[]]),
    stream: z.enum([...CONNECTOR_STREAMS] as [string, ...string[]]),
  })
  .strict();

export type ConnectorSyncInput = z.infer<typeof connectorSyncSchema>;
