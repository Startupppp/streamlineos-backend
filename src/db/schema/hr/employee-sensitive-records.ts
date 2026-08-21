import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { hrEmployeeSensitiveFields } from "./core-people";

export const hrEmployeeSensitiveDisciplinaryRecords = pgTable(
  "hr_employee_sensitive_disciplinary_records",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    disciplinaryRecordId: bigint("disciplinary_record_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    sensitiveFieldsId: integer("sensitive_fields_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    recordPayload: jsonb("record_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_hr_sensitive_disciplinary_records",
      columns: [table.organizationId, table.disciplinaryRecordId],
    }),
    unique("uniq_hr_sensitive_disciplinary_parent_order").on(
      table.organizationId,
      table.sensitiveFieldsId,
      table.sourceOrdinal,
    ),
    index("idx_hr_sensitive_disciplinary_parent").on(
      table.organizationId,
      table.sensitiveFieldsId,
      table.sourceOrdinal,
    ),
    foreignKey({
      name: "fk_hr_sensitive_disciplinary_parent",
      columns: [table.organizationId, table.sensitiveFieldsId],
      foreignColumns: [hrEmployeeSensitiveFields.orgId, hrEmployeeSensitiveFields.id],
    }).onDelete("cascade"),
    check(
      "chk_hr_sensitive_disciplinary_payload",
      sql`${table.sourceOrdinal} >= 0 AND jsonb_typeof(${table.recordPayload}) = 'object'`,
    ),
  ],
);

export const hrEmployeeSensitiveGrievanceRecords = pgTable(
  "hr_employee_sensitive_grievance_records",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    grievanceRecordId: bigint("grievance_record_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    sensitiveFieldsId: integer("sensitive_fields_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    recordPayload: jsonb("record_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_hr_sensitive_grievance_records",
      columns: [table.organizationId, table.grievanceRecordId],
    }),
    unique("uniq_hr_sensitive_grievance_parent_order").on(
      table.organizationId,
      table.sensitiveFieldsId,
      table.sourceOrdinal,
    ),
    index("idx_hr_sensitive_grievance_parent").on(
      table.organizationId,
      table.sensitiveFieldsId,
      table.sourceOrdinal,
    ),
    foreignKey({
      name: "fk_hr_sensitive_grievance_parent",
      columns: [table.organizationId, table.sensitiveFieldsId],
      foreignColumns: [hrEmployeeSensitiveFields.orgId, hrEmployeeSensitiveFields.id],
    }).onDelete("cascade"),
    check(
      "chk_hr_sensitive_grievance_payload",
      sql`${table.sourceOrdinal} >= 0 AND jsonb_typeof(${table.recordPayload}) = 'object'`,
    ),
  ],
);
