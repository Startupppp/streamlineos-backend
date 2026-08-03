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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
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
  ackBy: text("ack_by").references(() => users.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_timesheet_exports_org_type_created").on(
    table.orgId,
    table.exportType,
    table.createdAt,
  ),
  index("idx_timesheet_exports_created_by").on(table.createdBy),
  uniqueIndex("uniq_timesheet_exports_idem")
    .on(table.orgId, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
]);
