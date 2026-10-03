import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";

export type PayrollForm16DocumentStatus = "uploaded" | "released";

export const payrollForm16Documents = pgTable("payroll_form16_documents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  financialYear: text("financial_year").notNull(),
  userMembershipId: integer("user_membership_id").notNull(),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  status: text("status").$type<PayrollForm16DocumentStatus>().notNull().default("uploaded"),
  uploadedByMembershipId: integer("uploaded_by_membership_id"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  releasedByMembershipId: integer("released_by_membership_id"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uniq_payroll_form16_documents_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_form16_documents_subject_fy").on(table.orgId, table.userMembershipId, table.financialYear),
  index("idx_payroll_form16_documents_org_fy_status").on(table.orgId, table.financialYear, table.status),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_form16_documents_subject",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.uploadedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_form16_documents_uploaded_by",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.releasedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_form16_documents_released_by",
  }).onDelete("set null"),
  check("chk_payroll_form16_documents_status", sql`${table.status} IN ('uploaded', 'released')`),
  check("chk_payroll_form16_documents_fy", sql`${table.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check("chk_payroll_form16_documents_size", sql`${table.fileSizeBytes} > 0`),
  check("chk_payroll_form16_documents_released", sql`${table.status} <> 'released' OR ${table.releasedAt} IS NOT NULL`),
]);
