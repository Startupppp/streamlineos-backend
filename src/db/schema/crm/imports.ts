import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * What one line of the file will do, decided before anything is written.
 *
 * Declared here rather than imported from the import module: schema is the lower
 * layer — modules read it, not the other way round — so the shapes a column
 * stores are named here and the module imports them back.
 *
 * `merge` and `review` are not decorations on `skip` and `create`. A `merge` is
 * two lines of the file becoming one record, with the later line's values folded
 * into the earlier one — reported as a skip, that is a column the user can see
 * in their file and cannot find afterwards. A `review` is a line the duplicate
 * scorer was unsure about: it writes NOTHING and files a data-quality finding
 * instead, because creating a second record for a near-match is the speculative
 * write an import performs five thousand times before anybody notices.
 */
export type RowAction = "create" | "update" | "merge" | "review" | "skip";

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
  /**
   * The undo is running, and is not finished.
   *
   * A real state rather than a flag on `committed`: putting five thousand rows
   * back is many transactions across several attempts, and without it an undo
   * that stopped halfway is indistinguishable from one that never started —
   * which is how a half-reverted import gets reverted twice.
   */
  "reverting",
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
    /**
     * The durable run executing the commit, and the one executing the undo.
     *
     * Two columns rather than one, because an import that was committed and then
     * taken back has had two runs and the record of the first must survive the
     * second. Held so a repeated `commit` re-uses the live run instead of
     * starting a second one alongside it.
     */
    workflowRunId: text("workflow_run_id"),
    revertWorkflowRunId: text("revert_workflow_run_id"),

    /** No FK to users — see migration 0223. */
    createdByUserId: text("created_by_user_id"),
    committedAt: timestamp("committed_at"),
    /**
     * When this import stops being reversible.
     *
     * Stamped at the moment the commit finishes rather than derived from
     * `committed_at` and a constant, because it is a promise made to the tenant
     * at that moment. Deriving it would mean shortening the window in code
     * silently retracted an undo somebody was already relying on.
     */
    revertDeadlineAt: timestamp("revert_deadline_at"),
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
     * What the duplicate scorer saw, for the rows where what it saw is the
     * decision.
     *
     * Stored rather than recomputed at commit time for the same reason the
     * mapping is: the score is what put a row under review, and re-deriving it
     * against a table that has moved on would let the commit disagree with the
     * preview the tenant approved. It is also the evidence the data-quality
     * finding carries, so a person can judge the row without re-running an
     * import.
     */
    match: jsonb("match").$type<{ score: number; signals: string[]; candidateName?: string }>(),

    /**
     * What it actually did. Both halves are needed to undo it: one says what to
     * delete, the other what to put back. Without the before-image an undo can
     * remove what it created but not restore what it overwrote — which is the
     * half people actually care about.
     */
    createdPartyId: text("created_party_id"),
    previous: jsonb("previous").$type<Record<string, unknown>>(),
    /** The finding a `review` row filed, so the undo can close it again. */
    dataQualityFindingId: text("data_quality_finding_id"),

    /**
     * Set the instant a row is claimed, in the same savepoint as the write.
     *
     * This is the whole idempotency story. A batch step re-runs whenever its
     * previous attempt FAILED, and two runs can overlap after a dead-letter, so
     * the claim `committed_at IS NULL` is what stops a row being written twice —
     * and being in the row's savepoint is what makes a rolled-back row claimable
     * again.
     */
    committedAt: timestamp("committed_at"),
    /** The same claim, for the undo. A row is put back exactly once. */
    revertedAt: timestamp("reverted_at"),
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
    /**
     * The read every batch step makes: the outstanding rows of one window.
     *
     * Partial on `committed_at IS NULL`, so the index shrinks as the import
     * progresses instead of the scan growing — which is the difference between
     * a fifty-batch import costing fifty scans of the whole file and fifty
     * scans of what is left.
     */
    index("idx_crm_import_rows_pending")
      .on(t.organizationId, t.crmImportId, t.rowNumber)
      .where(sql`${t.committedAt} IS NULL`),
  ],
);
