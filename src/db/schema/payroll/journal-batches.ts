import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  decimal,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { payrollRuns } from "../hr/payroll-runs";
import { payrollEntities } from "./entities-periods";

export const payrollJournalBatchStatusEnum = pgEnum("payroll_journal_batch_status", [
  "DRAFT",
  "POSTED",
  "EXPORTED",
  "REVERSED",
  "FAILED",
]);

export const payrollJournalReconStatusEnum = pgEnum("payroll_journal_recon_status", [
  "UNRECONCILED",
  "RECONCILED",
  "DISPUTED",
]);

/**
 * Versioned accounting outbox for payroll (FR-ACC-001).
 *
 * A batch is an immutable snapshot of the journal built from a locked run.
 * Corrections never mutate a posted batch: a reversal batch is created with
 * debits and credits swapped and linked back via `reversalOfBatchId`, so the
 * ledger keeps a full audit trail. `sourceHash` makes creation idempotent —
 * rebuilding an unchanged run returns the existing batch instead of a duplicate.
 */
export const payrollJournalBatches = pgTable(
  "payroll_journal_batches",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: integer("entity_id").references(() => payrollEntities.id, {
      onDelete: "set null",
    }),
    runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "set null" }),
    periodKey: text("period_key").notNull(),
    version: integer("version").default(1).notNull(),
    status: payrollJournalBatchStatusEnum("status").default("DRAFT").notNull(),
    reconciliationStatus: payrollJournalReconStatusEnum("reconciliation_status")
      .default("UNRECONCILED")
      .notNull(),
    reversalOfBatchId: integer("reversal_of_batch_id").references(
      (): AnyPgColumn => payrollJournalBatches.id,
      { onDelete: "set null" },
    ),
    reversalReason: text("reversal_reason"),
    provisional: boolean("provisional").default(false).notNull(),
    sourceHash: text("source_hash").notNull(),
    totalDebits: decimal("total_debits", { precision: 15, scale: 2 }).notNull(),
    totalCredits: decimal("total_credits", { precision: 15, scale: 2 }).notNull(),
    lineCount: integer("line_count").default(0).notNull(),
    unmappedCodes: jsonb("unmapped_codes").$type<string[]>(),
    note: text("note"),
    reconciliationNote: text("reconciliation_note"),
    postedAt: timestamp("posted_at"),
    postedBy: text("posted_by").references(() => users.id, { onDelete: "set null" }),
    exportedAt: timestamp("exported_at"),
    exportedBy: text("exported_by").references(() => users.id, { onDelete: "set null" }),
    reversedAt: timestamp("reversed_at"),
    reversedBy: text("reversed_by").references(() => users.id, { onDelete: "set null" }),
    reconciledAt: timestamp("reconciled_at"),
    reconciledBy: text("reconciled_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_payroll_journal_batches_org_period_version").on(
      table.orgId,
      table.periodKey,
      table.version,
    ),
    index("idx_payroll_journal_batches_org_status").on(table.orgId, table.status),
    index("idx_payroll_journal_batches_org_run").on(table.orgId, table.runId),
    index("idx_payroll_journal_batches_org_recon").on(table.orgId, table.reconciliationStatus),
    index("idx_payroll_journal_batches_source_hash").on(table.orgId, table.sourceHash),
  ],
);

export const payrollJournalBatchLines = pgTable(
  "payroll_journal_batch_lines",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => payrollJournalBatches.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    account: text("account").notNull(),
    description: text("description").notNull(),
    debit: decimal("debit", { precision: 15, scale: 2 }).default("0").notNull(),
    credit: decimal("credit", { precision: 15, scale: 2 }).default("0").notNull(),
    costCenter: text("cost_center"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_payroll_journal_batch_lines_batch_line").on(table.batchId, table.lineNo),
    index("idx_payroll_journal_batch_lines_org_batch").on(table.orgId, table.batchId),
  ],
);

export const payrollJournalBatchesRelations = relations(
  payrollJournalBatches,
  ({ one, many }) => ({
    run: one(payrollRuns, {
      fields: [payrollJournalBatches.runId],
      references: [payrollRuns.id],
    }),
    entity: one(payrollEntities, {
      fields: [payrollJournalBatches.entityId],
      references: [payrollEntities.id],
    }),
    lines: many(payrollJournalBatchLines),
  }),
);

export const payrollJournalBatchLinesRelations = relations(
  payrollJournalBatchLines,
  ({ one }) => ({
    batch: one(payrollJournalBatches, {
      fields: [payrollJournalBatchLines.batchId],
      references: [payrollJournalBatches.id],
    }),
  }),
);
