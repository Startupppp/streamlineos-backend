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
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { workers } from "../directory/workers";
import { leaveTypes } from "./leaves";
import { workerLeaveLedgerEntries } from "./worker-leave-ledger";

export const workerLeaveBalanceProjections = pgTable(
  "worker_leave_balance_projections",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workerId: text("worker_id").notNull(),
    leaveTypeId: integer("leave_type_id").notNull(),
    periodKey: text("period_key").notNull(),
    balanceDays: numeric("balance_days", { precision: 12, scale: 4 })
      .default("0")
      .notNull(),
    lastProcessedEntryId: bigint("last_processed_entry_id", {
      mode: "bigint",
    }),
    lastProcessedEffectiveDate: date("last_processed_effective_date"),
    projectionVersion: integer("projection_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.workerId,
        table.leaveTypeId,
        table.periodKey,
      ],
      name: "pk_worker_leave_balance_projections",
    }),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_worker_leave_balances_org_worker",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.leaveTypeId],
      foreignColumns: [leaveTypes.orgId, leaveTypes.id],
      name: "fk_worker_leave_balances_org_leave_type",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.lastProcessedEffectiveDate,
        table.lastProcessedEntryId,
      ],
      foreignColumns: [
        workerLeaveLedgerEntries.organizationId,
        workerLeaveLedgerEntries.effectiveDate,
        workerLeaveLedgerEntries.entryId,
      ],
      name: "fk_worker_leave_balances_last_entry",
    }).onDelete("restrict"),
    index("idx_worker_leave_balances_org_leave_type").on(
      table.organizationId,
      table.leaveTypeId,
    ),
    index("idx_worker_leave_balances_last_entry").on(
      table.organizationId,
      table.lastProcessedEffectiveDate,
      table.lastProcessedEntryId,
    ),
    check(
      "chk_worker_leave_balances_last_entry_pair",
      sql`(${table.lastProcessedEntryId} IS NULL) = (${table.lastProcessedEffectiveDate} IS NULL)`,
    ),
    check(
      "chk_worker_leave_balances_projection_version",
      sql`${table.projectionVersion} > 0`,
    ),
    check(
      "chk_worker_leave_balances_period_key",
      sql`char_length(btrim(${table.periodKey})) > 0`,
    ),
    check(
      "chk_worker_leave_balances_balance_days",
      sql`${table.balanceDays} BETWEEN -1000000::numeric AND 1000000::numeric`,
    ),
  ],
);
