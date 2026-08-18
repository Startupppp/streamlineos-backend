import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { workerEngagements } from "../directory/worker-engagements";
import { workers } from "../directory/workers";
import { leaveTypes } from "./leaves";

export type WorkerLeaveEntryType =
  | "ACCRUAL"
  | "CONSUMPTION"
  | "CARRY_FORWARD"
  | "ENCASHMENT"
  | "EXPIRY"
  | "ADJUSTMENT"
  | "COMP_OFF_EARN"
  | "COMP_OFF_USE"
  | "REVERSAL"
  | "LEGACY_OPENING_BALANCE";

export type WorkerLeaveProvenanceStatus =
  | "VERIFIED_SOURCE"
  | "UNVERIFIED_LEGACY";

export const workerLeaveEntryLocators = pgTable(
  "worker_leave_entry_locators",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    entryId: bigint("entry_id", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAsIdentity(),
    effectiveDate: date("effective_date").notNull(),
    commandScope: text("command_scope").notNull(),
    commandId: text("command_id").notNull(),
    effectOrdinal: integer("effect_ordinal").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.entryId],
      name: "pk_worker_leave_entry_locators",
    }),
    unique("uniq_worker_leave_locators_entry_date").on(
      table.organizationId,
      table.entryId,
      table.effectiveDate,
    ),
    unique("uniq_worker_leave_locators_command").on(
      table.organizationId,
      table.commandScope,
      table.commandId,
      table.effectOrdinal,
    ),
    unique("uniq_worker_leave_locators_source").on(
      table.organizationId,
      table.sourceType,
      table.sourceId,
      table.sourceOrdinal,
    ),
    index("idx_worker_leave_locators_org_date").on(
      table.organizationId,
      table.effectiveDate,
    ),
    check(
      "chk_worker_leave_locators_command_key",
      sql`char_length(btrim(${table.commandScope})) > 0 AND char_length(btrim(${table.commandId})) > 0 AND ${table.effectOrdinal} >= 0`,
    ),
    check(
      "chk_worker_leave_locators_source_key",
      sql`char_length(btrim(${table.sourceType})) > 0 AND char_length(btrim(${table.sourceId})) > 0 AND ${table.sourceOrdinal} >= 0`,
    ),
  ],
);

export const workerLeaveLedgerEntries = pgTable(
  "worker_leave_ledger_entries",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    effectiveDate: date("effective_date").notNull(),
    entryId: bigint("entry_id", { mode: "bigint" }).notNull(),
    workerId: text("worker_id").notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    leaveTypeId: integer("leave_type_id").notNull(),
    periodKey: text("period_key").notNull(),
    deltaDays: numeric("delta_days", { precision: 12, scale: 4 }).notNull(),
    entryType: text("entry_type").$type<WorkerLeaveEntryType>().notNull(),
    provenanceStatus: text("provenance_status")
      .$type<WorkerLeaveProvenanceStatus>()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    commandScope: text("command_scope").notNull(),
    commandId: text("command_id").notNull(),
    effectOrdinal: integer("effect_ordinal").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    actorMembershipId: integer("actor_membership_id"),
    actorUserId: text("actor_user_id"),
    migrationBatchId: text("migration_batch_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.effectiveDate, table.entryId],
      name: "pk_worker_leave_ledger_entries",
    }),
    foreignKey({
      columns: [table.organizationId, table.entryId, table.effectiveDate],
      foreignColumns: [
        workerLeaveEntryLocators.organizationId,
        workerLeaveEntryLocators.entryId,
        workerLeaveEntryLocators.effectiveDate,
      ],
      name: "fk_worker_leave_entries_locator",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_worker_leave_entries_org_worker",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.workerId,
        table.workerEngagementId,
      ],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_worker_leave_entries_worker_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.leaveTypeId],
      foreignColumns: [leaveTypes.orgId, leaveTypes.id],
      name: "fk_worker_leave_entries_org_leave_type",
    }).onDelete("restrict"),
    index("idx_worker_leave_entries_balance_rebuild").on(
      table.organizationId,
      table.workerId,
      table.leaveTypeId,
      table.periodKey,
      table.effectiveDate,
      table.entryId,
    ),
    index("idx_worker_leave_entries_locator").on(
      table.organizationId,
      table.entryId,
      table.effectiveDate,
    ),
    index("idx_worker_leave_entries_org_engagement").on(
      table.organizationId,
      table.workerEngagementId,
    ),
    index("idx_worker_leave_entries_org_leave_type").on(
      table.organizationId,
      table.leaveTypeId,
    ),
    check(
      "chk_worker_leave_entries_entry_type",
      sql`${table.entryType} IN ('ACCRUAL','CONSUMPTION','CARRY_FORWARD','ENCASHMENT','EXPIRY','ADJUSTMENT','COMP_OFF_EARN','COMP_OFF_USE','REVERSAL','LEGACY_OPENING_BALANCE')`,
    ),
    check(
      "chk_worker_leave_entries_provenance",
      sql`${table.provenanceStatus} IN ('VERIFIED_SOURCE','UNVERIFIED_LEGACY')`,
    ),
    check(
      "chk_worker_leave_entries_legacy_pair",
      sql`(${table.provenanceStatus} = 'UNVERIFIED_LEGACY') = (${table.entryType} = 'LEGACY_OPENING_BALANCE')`,
    ),
    check(
      "chk_worker_leave_entries_migration_batch",
      sql`${table.migrationBatchId} IS NULL OR char_length(btrim(${table.migrationBatchId})) > 0`,
    ),
    check(
      "chk_worker_leave_entries_legacy_batch",
      sql`${table.provenanceStatus} <> 'UNVERIFIED_LEGACY' OR ${table.migrationBatchId} IS NOT NULL`,
    ),
    check(
      "chk_worker_leave_entries_command_key",
      sql`char_length(btrim(${table.commandScope})) > 0 AND char_length(btrim(${table.commandId})) > 0 AND ${table.effectOrdinal} >= 0`,
    ),
    check(
      "chk_worker_leave_entries_source_key",
      sql`char_length(btrim(${table.sourceType})) > 0 AND char_length(btrim(${table.sourceId})) > 0 AND ${table.sourceOrdinal} >= 0`,
    ),
    check(
      "chk_worker_leave_entries_period_key",
      sql`char_length(btrim(${table.periodKey})) > 0`,
    ),
    check(
      "chk_worker_leave_entries_delta_days",
      sql`${table.deltaDays} BETWEEN -1000000::numeric AND 1000000::numeric AND ${table.deltaDays} <> 0`,
    ),
  ],
);

export const workerLeaveReversalLinks = pgTable(
  "worker_leave_reversal_links",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    originalEntryId: bigint("original_entry_id", { mode: "bigint" }).notNull(),
    originalEffectiveDate: date("original_effective_date").notNull(),
    reversalEntryId: bigint("reversal_entry_id", { mode: "bigint" }).notNull(),
    reversalEffectiveDate: date("reversal_effective_date").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.originalEntryId],
      name: "pk_worker_leave_reversal_links",
    }),
    unique("uniq_worker_leave_reversal_links_reversal").on(
      table.organizationId,
      table.reversalEntryId,
    ),
    foreignKey({
      columns: [
        table.organizationId,
        table.originalEffectiveDate,
        table.originalEntryId,
      ],
      foreignColumns: [
        workerLeaveLedgerEntries.organizationId,
        workerLeaveLedgerEntries.effectiveDate,
        workerLeaveLedgerEntries.entryId,
      ],
      name: "fk_worker_leave_reversal_original_fact",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.originalEntryId],
      foreignColumns: [
        workerLeaveEntryLocators.organizationId,
        workerLeaveEntryLocators.entryId,
      ],
      name: "fk_worker_leave_reversal_original_locator",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.reversalEffectiveDate,
        table.reversalEntryId,
      ],
      foreignColumns: [
        workerLeaveLedgerEntries.organizationId,
        workerLeaveLedgerEntries.effectiveDate,
        workerLeaveLedgerEntries.entryId,
      ],
      name: "fk_worker_leave_reversal_reversal_fact",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.reversalEntryId],
      foreignColumns: [
        workerLeaveEntryLocators.organizationId,
        workerLeaveEntryLocators.entryId,
      ],
      name: "fk_worker_leave_reversal_reversal_locator",
    }).onDelete("restrict"),
    index("idx_worker_leave_reversal_original_fact").on(
      table.organizationId,
      table.originalEffectiveDate,
      table.originalEntryId,
    ),
    index("idx_worker_leave_reversal_reversal_fact").on(
      table.organizationId,
      table.reversalEffectiveDate,
      table.reversalEntryId,
    ),
    check(
      "chk_worker_leave_reversal_not_self",
      sql`${table.originalEntryId} <> ${table.reversalEntryId}`,
    ),
  ],
);
