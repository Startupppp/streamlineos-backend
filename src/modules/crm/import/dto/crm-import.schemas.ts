import { z } from "zod";
import { ALL_IMPORT_FIELDS, IMPORT_ENTITIES } from "../import-entities";
import { CONNECTOR_PROVIDERS, CONNECTOR_STREAMS } from "../connectors/connector-source";
import { EXPORT_ENTITIES } from "../crm-export.service";

/** A paste, not a migration. The direct connectors are Phase 2. */
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 100;
const MAX_CELL = 5_000;

export const previewImportSchema = z
  .object({
    filename: z.string().max(255).optional(),
    /**
     * Which entity this file lands as.
     *
     * Defaulted rather than required, because every file that reached this
     * endpoint before the column existed was a party file and a caller that has
     * not been updated must keep meaning what it meant.
     */
    entity: z.enum(IMPORT_ENTITIES).default("party"),
    /**
     * Which subject type a subject import lands as.
     *
     * Not something the file can say: no column of somebody else's export names
     * one of this tenant's declared types. Refused here when it is missing on a
     * subject import, and refused as "not found" when it belongs to another
     * organisation.
     */
    subjectTypeId: z.string().max(64).optional(),
    headers: z.array(z.string().max(200)).min(1).max(MAX_COLUMNS),
    rows: z
      .array(z.array(z.string().max(MAX_CELL)).max(MAX_COLUMNS))
      .max(MAX_ROWS),
    /**
     * A person's answers to ambiguous columns, keyed by header.
     *
     * `__ignore__` is an answer too — "this column is not for you" is a
     * decision, and treating it as unanswered would ask again forever.
     *
     * The enum is the union of all four vocabularies, because a Zod enum is
     * built before this request's `entity` is known. `applyOverrides` narrows
     * again against the entity's own fields and refuses with a sentence, so
     * naming a real field of a different entity is a 409 rather than a column
     * silently dropped.
     */
    overrides: z
      .record(z.string().max(200), z.enum([...ALL_IMPORT_FIELDS, "__ignore__"]))
      .optional(),
  })
  .strict()
  /**
   * A subject import needs its type, and nothing else may carry one.
   *
   * Mirrors `chk_crm_imports_subject_type` rather than trusting the service to
   * remember: the database refuses the pair anyway, and a 400 naming the field
   * is a better answer than a constraint violation.
   */
  .refine((body) => (body.entity === "subject") === Boolean(body.subjectTypeId), {
    message: "A subject import needs a subjectTypeId, and no other import may have one.",
    path: ["subjectTypeId"],
  });

export type PreviewImportInput = z.infer<typeof previewImportSchema>;

export const exportQuerySchema = z
  .object({
    entity: z.enum(EXPORT_ENTITIES),
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
    provider: z.enum(CONNECTOR_PROVIDERS),
    stream: z.enum(CONNECTOR_STREAMS),
  })
  .strict();

export type ConnectorSyncInput = z.infer<typeof connectorSyncSchema>;
