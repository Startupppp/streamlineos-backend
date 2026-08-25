import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Declared here rather than imported from the import module.
 *
 * Schema is the lower layer — modules read it, not the other way round — so the
 * shapes a column stores are named here and the module imports them back.
 */
export type RowAction = "create" | "update" | "skip";

/** The stored form of one column's decided meaning. */
export interface StoredColumnMapping {
  readonly header: string;
  readonly mapping:
    | { readonly kind: "mapped"; readonly field: string; readonly confidence: number }
    | { readonly kind: "custom"; readonly key: string }
    | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
    | { readonly kind: "unmapped" };
}

export const IMPORT_STATUSES = [
  "previewing",
  "committing",
  "committed",
  "reverted",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** One attempt to bring a file in. */
export const crmImports = pgTable(
  "crm_imports",
  {
    crmImportId: text("crm_import_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    status: text("status").$type<ImportStatus>().default("previewing").notNull(),
    sourceFilename: text("source_filename"),

    /**
     * The confirmed mapping, stored rather than re-inferred.
     *
     * Re-inferring on read would let the answer change after somebody resolved
     * an ambiguous column, and the commit would then not be the thing that was
     * previewed.
     */
    columns: jsonb("columns").$type<StoredColumnMapping[]>(),
    summary: jsonb("summary").$type<Record<string, number>>(),
    workflowRunId: text("workflow_run_id"),

    /** No FK to users — see migration 0223. */
    createdByUserId: text("created_by_user_id"),
    committedAt: timestamp("committed_at"),
    revertedAt: timestamp("reverted_at"),
    revertedByUserId: text("reverted_by_user_id"),
    error: text("error"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_crm_imports_org_created").on(t.organizationId, t.createdAt),
    unique("uniq_crm_imports_org_id").on(t.organizationId, t.crmImportId),
  ],
);

/**
 * One row per line of the file, with its action already decided.
 *
 * The preview reads these and the commit executes these, so "the committed
 * result matches the preview" holds structurally rather than because two code
 * paths were written to agree.
 */
export const crmImportRows = pgTable(
  "crm_import_rows",
  {
    crmImportRowId: text("crm_import_row_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    crmImportId: text("crm_import_id").notNull(),

    /** 1-based, matching what the user sees in their spreadsheet. */
    rowNumber: integer("row_number").notNull(),
    action: text("action").$type<RowAction>().notNull(),
    reason: text("reason"),

    values: jsonb("values").$type<Record<string, string>>(),
    customFields: jsonb("custom_fields").$type<Record<string, string>>(),
    matchedPartyId: text("matched_party_id"),
    duplicateOfRow: integer("duplicate_of_row"),

    /**
     * What it actually did. Both halves are needed to undo it: one says what to
     * delete, the other what to put back. Without the before-image an undo can
     * remove what it created but not restore what it overwrote — which is the
     * half people actually care about.
     */
    createdPartyId: text("created_party_id"),
    previous: jsonb("previous").$type<Record<string, unknown>>(),

    committedAt: timestamp("committed_at"),
    error: text("error"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // A retry that re-planned would otherwise double every row, and the preview
    // would stop matching the commit.
    uniqueIndex("uniq_crm_import_rows_line").on(t.organizationId, t.crmImportId, t.rowNumber),
    index("idx_crm_import_rows_import").on(t.organizationId, t.crmImportId, t.rowNumber),
    index("idx_crm_import_rows_committed")
      .on(t.organizationId, t.crmImportId)
      .where(sql`${t.committedAt} IS NOT NULL`),
  ],
);
