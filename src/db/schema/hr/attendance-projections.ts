import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { workers } from "../directory/workers";
import { workerEngagements } from "../directory/worker-engagements";
import { attendanceEvents } from "./attendance-event-store";

export const attendanceSessionStateEnum = pgEnum(
  "attendance_session_state",
  ["WORKING", "ON_BREAK", "CLOSED"],
);

export const attendanceSessionProjections = pgTable(
  "attendance_session_projections",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sessionId: bigint("session_id", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAsIdentity(),
    businessDate: date("business_date").notNull(),
    workerId: text("worker_id").notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    state: attendanceSessionStateEnum("state").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    breakStartedAt: timestamp("break_started_at", { withTimezone: true }),
    workedMinutes: integer("worked_minutes").default(0).notNull(),
    breakMinutes: integer("break_minutes").default(0).notNull(),
    openedEventBusinessDate: date("opened_event_business_date").notNull(),
    openedEventId: bigint("opened_event_id", { mode: "bigint" }).notNull(),
    lastEventBusinessDate: date("last_event_business_date").notNull(),
    lastEventId: bigint("last_event_id", { mode: "bigint" }).notNull(),
    projectionVersion: bigint("projection_version", { mode: "number" })
      .default(1)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.sessionId],
      name: "pk_attendance_session_projections",
    }),
    uniqueIndex("uniq_attendance_session_projections_open_worker")
      .on(table.organizationId, table.workerId)
      .where(sql`${table.closedAt} IS NULL`),
    index("idx_attendance_session_projections_worker_date").on(
      table.organizationId,
      table.workerId,
      table.businessDate,
    ),
    index("idx_attendance_session_projections_state").on(
      table.organizationId,
      table.state,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_attendance_session_projections_worker",
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
      name: "fk_attendance_session_worker_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.openedEventBusinessDate,
        table.openedEventId,
      ],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_session_projections_opened_event",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.lastEventBusinessDate,
        table.lastEventId,
      ],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_session_projections_last_event",
    }).onDelete("restrict"),
    check(
      "chk_attendance_session_projections_state",
      sql`(${table.state} = 'CLOSED' AND ${table.closedAt} IS NOT NULL) OR (${table.state} <> 'CLOSED' AND ${table.closedAt} IS NULL)`,
    ),
    check(
      "chk_attendance_session_projections_break",
      sql`(${table.state} = 'ON_BREAK' AND ${table.breakStartedAt} IS NOT NULL) OR (${table.state} <> 'ON_BREAK' AND ${table.breakStartedAt} IS NULL)`,
    ),
    check(
      "chk_attendance_session_projections_times",
      sql`${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`,
    ),
    check(
      "chk_attendance_session_projections_totals",
      sql`${table.workedMinutes} >= 0 AND ${table.breakMinutes} >= 0 AND ${table.projectionVersion} > 0`,
    ),
    check(
      "chk_attendance_session_projections_event_dates",
      sql`${table.openedEventBusinessDate} = ${table.businessDate} AND ${table.lastEventBusinessDate} = ${table.businessDate}`,
    ),
  ],
);

export const attendanceDailyProjections = pgTable(
  "attendance_daily_projections",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    businessDate: date("business_date").notNull(),
    workerId: text("worker_id").notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    firstCheckInAt: timestamp("first_check_in_at", { withTimezone: true }),
    lastCheckOutAt: timestamp("last_check_out_at", { withTimezone: true }),
    workedMinutes: integer("worked_minutes").default(0).notNull(),
    breakMinutes: integer("break_minutes").default(0).notNull(),
    overtimeMinutes: integer("overtime_minutes").default(0).notNull(),
    sessionCount: integer("session_count").default(0).notNull(),
    hasOpenSession: boolean("has_open_session").default(false).notNull(),
    lastEventBusinessDate: date("last_event_business_date").notNull(),
    lastEventId: bigint("last_event_id", { mode: "bigint" }).notNull(),
    projectionVersion: bigint("projection_version", { mode: "number" })
      .default(1)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.businessDate, table.workerId],
      name: "pk_attendance_daily_projections",
    }),
    index("idx_attendance_daily_projections_worker_date").on(
      table.organizationId,
      table.workerId,
      table.businessDate,
    ),
    index("idx_attendance_daily_projections_date").on(
      table.organizationId,
      table.businessDate,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_attendance_daily_projections_worker",
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
      name: "fk_attendance_daily_worker_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.lastEventBusinessDate,
        table.lastEventId,
      ],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_daily_projections_last_event",
    }).onDelete("restrict"),
    check(
      "chk_attendance_daily_projections_totals",
      sql`${table.workedMinutes} >= 0 AND ${table.breakMinutes} >= 0 AND ${table.overtimeMinutes} >= 0 AND ${table.sessionCount} >= 0 AND ${table.projectionVersion} > 0`,
    ),
    check(
      "chk_attendance_daily_projections_times",
      sql`${table.firstCheckInAt} IS NULL OR ${table.lastCheckOutAt} IS NULL OR ${table.lastCheckOutAt} >= ${table.firstCheckInAt}`,
    ),
    check(
      "chk_attendance_daily_projections_event_date",
      sql`${table.lastEventBusinessDate} = ${table.businessDate}`,
    ),
  ],
);
