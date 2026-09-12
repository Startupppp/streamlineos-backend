import {
  pgTable,
  text,
  serial,
  timestamp,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
  jsonb,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import {
  timesheetExportTypeEnum,
  timesheetExportStatusEnum,
  timesheetExportFormatEnum,
} from "./enums";

export const timesheetExports = pgTable("timesheet_exports", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  exportType: timesheetExportTypeEnum("export_type").notNull().default("PAYROLL"),
  status: timesheetExportStatusEnum("status").notNull().default("COMPLETED"),
  dateRangeStart: date("date_range_start").notNull(),
  dateRangeEnd: date("date_range_end").notNull(),
  format: timesheetExportFormatEnum("format").notNull(),
  filters: jsonb("filters").$type<object>(),
  snapshot: jsonb("snapshot").$type<object>().notNull(),
  entryCount: integer("entry_count").notNull().default(0),
  totalHours: decimal("total_hours", { precision: 10, scale: 2 }).notNull().default("0"),
  fileUrl: text("file_url"),
  note: text("note"),
  idempotencyKey: text("idempotency_key"),
  ackStatus: text("ack_status"),
  ackNote: text("ack_note"),
  ackAt: timestamp("ack_at"),
  ackByMembershipId: integer("ack_by_membership_id"),
  createdByMembershipId: integer("created_by_membership_id"),
  /**
   * The export's outbox `aggregate_version`, on the same terms as
   * `timesheet_periods.event_seq`: the creation event is version 1, and every
   * acknowledgement claims the next number with `event_seq + 1` inside the
   * UPDATE that records it, so the counter and the status commit together and
   * two concurrent acknowledgements serialise on the row. The wall-clock
   * millisecond it replaced was unique only by luck and ordered only within
   * one node's clock.
   */
  eventSeq: integer("event_seq").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_timesheet_exports_org_type_created").on(
    table.orgId,
    table.exportType,
    table.createdAt,
  ),
  uniqueIndex("uniq_timesheet_exports_idem")
    .on(table.orgId, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_exports_created_by_membership",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.ackByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_exports_ack_by_membership",
  }).onDelete("set null"),
]);
