import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import {
  attendanceEvents,
  attendanceEventSourceEnum,
} from "./attendance-event-store";

export const attendanceEventEvidence = pgTable(
  "attendance_event_evidence",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    businessDate: date("business_date").notNull(),
    evidenceId: bigint("evidence_id", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAsIdentity(),
    eventId: bigint("event_id", { mode: "bigint" }).notNull(),
    encryptedCoordinates: text("encrypted_coordinates").notNull(),
    wrappedDataKey: text("wrapped_data_key").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    kmsKeyVersion: text("kms_key_version").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    coordinateDecimalPlaces: integer("coordinate_decimal_places").notNull(),
    captureSource: attendanceEventSourceEnum("capture_source").notNull(),
    deviceFingerprintHash: text("device_fingerprint_hash"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.businessDate, table.evidenceId],
      name: "pk_attendance_event_evidence",
    }),
    unique("uniq_attendance_event_evidence_event").on(
      table.organizationId,
      table.businessDate,
      table.eventId,
    ),
    index("idx_attendance_event_evidence_expiry").on(
      table.organizationId,
      table.retentionExpiresAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.businessDate, table.eventId],
      foreignColumns: [
        attendanceEvents.organizationId,
        attendanceEvents.businessDate,
        attendanceEvents.eventId,
      ],
      name: "fk_attendance_event_evidence_event",
    }).onDelete("restrict"),
    check(
      "chk_attendance_event_evidence_encryption",
      sql`${table.encryptionVersion} > 0 AND btrim(${table.encryptedCoordinates}) <> '' AND btrim(${table.wrappedDataKey}) <> '' AND btrim(${table.kmsKeyId}) <> '' AND btrim(${table.kmsKeyVersion}) <> ''`,
    ),
    check(
      "chk_attendance_event_evidence_precision",
      sql`${table.coordinateDecimalPlaces} BETWEEN 0 AND 4`,
    ),
    check(
      "chk_attendance_event_evidence_retention",
      sql`${table.retentionExpiresAt} > ${table.capturedAt} AND ${table.retentionExpiresAt} <= ${table.capturedAt} + interval '30 days'`,
    ),
  ],
);

export const attendanceEvidenceLegalHolds = pgTable(
  "attendance_evidence_legal_holds",
  {
    organizationId: text("organization_id").notNull(),
    businessDate: date("business_date").notNull(),
    evidenceId: bigint("evidence_id", { mode: "bigint" }).notNull(),
    caseId: text("case_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    approvedByMembershipId: integer("approved_by_membership_id").notNull(),
    secondApproverMembershipId: integer(
      "second_approver_membership_id",
    ).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    reviewDueAt: timestamp("review_due_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.businessDate, table.evidenceId],
      name: "pk_attendance_evidence_legal_holds",
    }),
    foreignKey({
      columns: [table.organizationId, table.businessDate, table.evidenceId],
      foreignColumns: [
        attendanceEventEvidence.organizationId,
        attendanceEventEvidence.businessDate,
        attendanceEventEvidence.evidenceId,
      ],
      name: "fk_attendance_evidence_legal_holds_evidence",
    }).onDelete("cascade"),
    index("idx_attendance_evidence_legal_holds_review").on(
      table.organizationId,
      table.reviewDueAt,
    ),
    check(
      "chk_attendance_evidence_legal_holds_approvers",
      sql`${table.approvedByMembershipId} <> ${table.secondApproverMembershipId}`,
    ),
    check(
      "chk_attendance_evidence_legal_holds_text",
      sql`btrim(${table.caseId}) <> '' AND btrim(${table.reasonCode}) <> ''`,
    ),
    check(
      "chk_attendance_evidence_legal_holds_window",
      sql`${table.reviewDueAt} > ${table.approvedAt} AND ${table.reviewDueAt} <= ${table.approvedAt} + interval '90 days' AND ${table.expiresAt} >= ${table.reviewDueAt}`,
    ),
    check(
      "chk_attendance_evidence_legal_holds_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);
