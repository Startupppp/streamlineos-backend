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
  unique,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { payrollRuns } from "./runs";
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
    postedByMembershipId: integer("posted_by_membership_id"),
    exportedAt: timestamp("exported_at"),
    exportedBy: text("exported_by").references(() => users.id, { onDelete: "set null" }),
    exportedByMembershipId: integer("exported_by_membership_id"),
    reversedAt: timestamp("reversed_at"),
    reversedBy: text("reversed_by").references(() => users.id, { onDelete: "set null" }),
    reversedByMembershipId: integer("reversed_by_membership_id"),
    reconciledAt: timestamp("reconciled_at"),
    reconciledBy: text("reconciled_by").references(() => users.id, { onDelete: "set null" }),
    reconciledByMembershipId: integer("reconciled_by_membership_id"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_payroll_journal_batches_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_journal_batches_org_period_version").on(
      table.orgId,
      table.periodKey,
      table.version,
    ),
    index("idx_payroll_journal_batches_org_status").on(table.orgId, table.status),
    index("idx_payroll_journal_batches_org_run").on(table.orgId, table.runId),
    index("idx_payroll_journal_batches_org_recon").on(table.orgId, table.reconciliationStatus),
    index("idx_payroll_journal_batches_source_hash").on(table.orgId, table.sourceHash),
    index("idx_payroll_jrnl_batches_org_posted_actor").on(table.orgId, table.postedByMembershipId),
    index("idx_payroll_jrnl_batches_org_exported_actor").on(table.orgId, table.exportedByMembershipId),
    index("idx_payroll_jrnl_batches_org_reversed_actor").on(table.orgId, table.reversedByMembershipId),
    index("idx_payroll_jrnl_batches_org_reconciled_actor").on(table.orgId, table.reconciledByMembershipId),
    index("idx_payroll_jrnl_batches_org_created_actor").on(table.orgId, table.createdByMembershipId),
    foreignKey({
      columns: [table.orgId, table.postedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_payroll_jrnl_batches_posted_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.exportedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_payroll_jrnl_batches_exported_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.reversedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_payroll_jrnl_batches_reversed_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.reconciledByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_payroll_jrnl_batches_reconciled_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_payroll_jrnl_batches_created_actor",
    }).onDelete("set null"),
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
    unique("uniq_payroll_jrnl_batch_lines_org_id").on(table.orgId, table.id),
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
