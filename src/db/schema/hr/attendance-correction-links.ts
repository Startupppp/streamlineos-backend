import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import {
  attendanceEventLocators,
  attendanceEvents,
} from "./attendance-event-store";

export const attendanceCorrectionLinks = pgTable(
  "attendance_correction_links",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    originalBusinessDate: date("original_business_date").notNull(),
    originalEventId: bigint("original_event_id", { mode: "bigint" }).notNull(),
    correctionBusinessDate: date("correction_business_date").notNull(),
    correctionEventId: bigint("correction_event_id", {
      mode: "bigint",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.originalEventId],
      name: "pk_attendance_correction_links",
    }),
    unique("uniq_attendance_correction_links_correction").on(
      table.organizationId,
      table.correctionEventId,
    ),
    foreignKey({
      columns: [table.organizationId, table.originalEventId],
      foreignColumns: [
        attendanceEventLocators.organizationId,
        attendanceEventLocators.eventId,
      ],
      name: "fk_attendance_correction_links_original_locator",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.correctionEventId],
      foreignColumns: [
        attendanceEventLocators.organizationId,
        attendanceEventLocators.eventId,
      ],
      name: "fk_attendance_correction_links_correction_locator",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.originalBusinessDate,
        table.originalEventId,
      ],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_correction_links_original_fact",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.correctionBusinessDate,
        table.correctionEventId,
      ],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_correction_links_correction_fact",
    }).onDelete("restrict"),
    index("idx_attendance_correction_links_original_fact").on(
      table.organizationId,
      table.originalBusinessDate,
      table.originalEventId,
    ),
    index("idx_attendance_correction_links_correction_fact").on(
      table.organizationId,
      table.correctionBusinessDate,
      table.correctionEventId,
    ),
    check(
      "chk_attendance_correction_links_not_self",
      sql`${table.originalEventId} <> ${table.correctionEventId}`,
    ),
  ],
);
