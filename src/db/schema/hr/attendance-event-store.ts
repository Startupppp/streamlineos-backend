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
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { workers } from "../directory/workers";
import { workerEngagements } from "../directory/worker-engagements";
import { geofences } from "./geofencing";

export const attendanceEventKindEnum = pgEnum("attendance_event_kind", [
  "CHECK_IN",
  "CHECK_OUT",
  "BREAK_START",
  "BREAK_END",
  "AUTO_CHECKOUT",
  "CORRECTION",
]);

export const attendanceEventSourceEnum = pgEnum("attendance_event_source", [
  "SELF_SERVICE",
  "HR_ADMIN",
  "BIOMETRIC_DEVICE",
  "REGULARIZATION",
  "IMPORT",
  "MIGRATION",
  "SYSTEM",
]);

export const attendanceCorrectionActionEnum = pgEnum(
  "attendance_correction_action",
  ["VOID", "REPLACE"],
);

export const attendanceCorrectionReplacementKindEnum = pgEnum(
  "attendance_correction_replacement_kind",
  ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END", "AUTO_CHECKOUT"],
);

export const attendanceAccuracyBucketEnum = pgEnum(
  "attendance_accuracy_bucket",
  ["LE_10_M", "GT_10_LE_50_M", "GT_50_LE_100_M", "GT_100_M", "UNKNOWN"],
);

export const attendanceDistanceBucketEnum = pgEnum(
  "attendance_distance_bucket",
  ["INSIDE_RADIUS", "OUTSIDE_LE_50_M", "OUTSIDE_GT_50_M", "UNKNOWN"],
);

export const attendanceEventLocators = pgTable(
  "attendance_event_locators",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventId: bigint("event_id", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAsIdentity(),
    businessDate: date("business_date").notNull(),
    commandScope: text("command_scope").notNull(),
    commandId: text("command_id").notNull(),
    effectOrdinal: integer("effect_ordinal").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.eventId],
      name: "pk_attendance_event_locators",
    }),
    unique("uniq_attendance_event_locators_org_event_date").on(
      table.organizationId,
      table.eventId,
      table.businessDate,
    ),
    unique("uniq_attendance_event_locators_command").on(
      table.organizationId,
      table.commandScope,
      table.commandId,
      table.effectOrdinal,
    ),
    unique("uniq_attendance_event_locators_source").on(
      table.organizationId,
      table.sourceType,
      table.sourceId,
      table.sourceOrdinal,
    ),
    index("idx_attendance_event_locators_org_date").on(
      table.organizationId,
      table.businessDate,
    ),
    check(
      "chk_attendance_event_locators_ordinals",
      sql`${table.effectOrdinal} >= 0 AND ${table.sourceOrdinal} >= 0`,
    ),
    check(
      "chk_attendance_event_locators_keys",
      sql`btrim(${table.commandScope}) <> '' AND btrim(${table.commandId}) <> '' AND btrim(${table.sourceType}) <> '' AND btrim(${table.sourceId}) <> ''`,
    ),
  ],
);

export const attendanceEvents = pgTable(
  "attendance_events",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    businessDate: date("business_date").notNull(),
    eventId: bigint("event_id", { mode: "bigint" }).notNull(),
    workerId: text("worker_id").notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    eventKind: attendanceEventKindEnum("event_kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    organizationTimezone: text("organization_timezone").notNull(),
    eventSource: attendanceEventSourceEnum("event_source").notNull(),
    commandScope: text("command_scope").notNull(),
    commandId: text("command_id").notNull(),
    effectOrdinal: integer("effect_ordinal").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    actorMembershipId: integer("actor_membership_id"),
    actorUserId: text("actor_user_id"),
    migrationBatchId: text("migration_batch_id"),
    geofenceId: integer("geofence_id"),
    geofencePassed: boolean("geofence_passed"),
    accuracyBucket: attendanceAccuracyBucketEnum("accuracy_bucket"),
    distanceBucket: attendanceDistanceBucketEnum("distance_bucket"),
    correctsBusinessDate: date("corrects_business_date"),
    correctsEventId: bigint("corrects_event_id", { mode: "bigint" }),
    correctionAction: attendanceCorrectionActionEnum("correction_action"),
    replacementEventKind: attendanceCorrectionReplacementKindEnum(
      "replacement_event_kind",
    ),
    replacementOccurredAt: timestamp("replacement_occurred_at", {
      withTimezone: true,
    }),
    correctionReasonCode: text("correction_reason_code"),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.businessDate, table.eventId],
      name: "pk_attendance_events",
    }),
    index("idx_attendance_events_org_worker_date").on(
      table.organizationId,
      table.workerId,
      table.businessDate,
    ),
    index("idx_attendance_events_org_engagement_date").on(
      table.organizationId,
      table.workerEngagementId,
      table.businessDate,
    ),
    index("idx_attendance_events_org_kind_date").on(
      table.organizationId,
      table.eventKind,
      table.businessDate,
    ),
    foreignKey({
      columns: [table.organizationId, table.eventId, table.businessDate],
      foreignColumns: [
        attendanceEventLocators.organizationId,
        attendanceEventLocators.eventId,
        attendanceEventLocators.businessDate,
      ],
      name: "fk_attendance_events_locator",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_attendance_events_worker",
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
      name: "fk_attendance_events_worker_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.geofenceId],
      foreignColumns: [geofences.orgId, geofences.id],
      name: "fk_attendance_events_geofence",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.correctsBusinessDate,
        table.correctsEventId,
      ],
      foreignColumns: [table.organizationId, table.businessDate, table.eventId],
      name: "fk_attendance_events_correction_target",
    }).onDelete("restrict"),
    check(
      "chk_attendance_events_timezone",
      sql`btrim(${table.organizationTimezone}) <> ''`,
    ),
    check(
      "chk_attendance_events_command_source",
      sql`btrim(${table.commandScope}) <> '' AND btrim(${table.commandId}) <> '' AND ${table.effectOrdinal} >= 0 AND btrim(${table.sourceType}) <> '' AND btrim(${table.sourceId}) <> '' AND ${table.sourceOrdinal} >= 0 AND (${table.migrationBatchId} IS NULL OR btrim(${table.migrationBatchId}) <> '')`,
    ),
    check(
      "chk_attendance_events_geofence_pair",
      sql`(${table.geofenceId} IS NULL) = (${table.geofencePassed} IS NULL)`,
    ),
    check(
      "chk_attendance_events_correction_shape",
      sql`(${table.eventKind} = 'CORRECTION' AND ${table.correctsBusinessDate} IS NOT NULL AND ${table.correctsEventId} IS NOT NULL AND ${table.correctionAction} IS NOT NULL AND ${table.correctionReasonCode} IS NOT NULL AND btrim(${table.correctionReasonCode}) <> '') OR (${table.eventKind} <> 'CORRECTION' AND ${table.correctsBusinessDate} IS NULL AND ${table.correctsEventId} IS NULL AND ${table.correctionAction} IS NULL AND ${table.replacementEventKind} IS NULL AND ${table.replacementOccurredAt} IS NULL AND ${table.correctionReasonCode} IS NULL)`,
    ),
    check(
      "chk_attendance_events_replacement_shape",
      sql`(${table.correctionAction} = 'REPLACE' AND ${table.replacementEventKind} IS NOT NULL AND ${table.replacementOccurredAt} IS NOT NULL) OR (${table.correctionAction} = 'VOID' AND ${table.replacementEventKind} IS NULL AND ${table.replacementOccurredAt} IS NULL) OR (${table.correctionAction} IS NULL AND ${table.replacementEventKind} IS NULL AND ${table.replacementOccurredAt} IS NULL)`,
    ),
    check(
      "chk_attendance_events_not_self_correction",
      sql`${table.correctsEventId} IS NULL OR ${table.correctsEventId} <> ${table.eventId} OR ${table.correctsBusinessDate} <> ${table.businessDate}`,
    ),
  ],
);
