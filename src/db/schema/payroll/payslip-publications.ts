import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { workers } from "../directory/workers";
import { payslipPublishChannelEnum } from "../common/enums";
import { payslipPublicationStatusEnum } from "./enums";
import { payrollRuns, payrollRunEmployees } from "./runs";
import { payslipTemplates } from "./payout";

export const payslipPublications = pgTable("payslip_publications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "restrict" }).notNull(),
  runEmployeeId: integer("run_employee_id").references(() => payrollRunEmployees.id, { onDelete: "restrict" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "restrict" }),
  userMembershipId: integer("user_membership_id"),
  workerId: text("worker_id"),
  payslipTemplateId: integer("payslip_template_id").references(() => payslipTemplates.id, { onDelete: "set null" }),
  pdfUrl: text("pdf_url"),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  channel: payslipPublishChannelEnum("channel").notNull().default("PORTAL"),
  status: payslipPublicationStatusEnum("status").notNull().default("PENDING"),
  snapshotHash: text("snapshot_hash"),
  failureReason: text("failure_reason"),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lastAttemptAt: timestamp("last_attempt_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payslip_publications_org_id").on(table.orgId, table.id),
  index("idx_payslip_publications_run").on(table.runId),
  index("idx_payslip_publications_user").on(table.userId),
  index("idx_payslip_publications_org_status").on(table.orgId, table.status),
  index("idx_payslip_publications_org_user_actor").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payslip_publications_user_actor",
  }).onDelete("set null"),
  uniqueIndex("uniq_payslip_publications_run_employee").on(table.runEmployeeId),
  index("idx_payslip_publications_org_worker").on(table.orgId, table.workerId),
  check(
    "chk_payslip_publications_subject",
    sql`user_id IS NOT NULL OR worker_id IS NOT NULL`,
  ),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_payslip_publications_org_worker",
  }).onDelete("restrict"),
]);

export const payslipPublicationsRelations = relations(payslipPublications, ({ one }) => ({
  organization: one(organizations, {
    fields: [payslipPublications.orgId],
    references: [organizations.id],
  }),
  run: one(payrollRuns, {
    fields: [payslipPublications.runId],
    references: [payrollRuns.id],
  }),
  runEmployee: one(payrollRunEmployees, {
    fields: [payslipPublications.runEmployeeId],
    references: [payrollRunEmployees.id],
  }),
  user: one(users, {
    fields: [payslipPublications.userId],
    references: [users.id],
  }),
  payslipTemplate: one(payslipTemplates, {
    fields: [payslipPublications.payslipTemplateId],
    references: [payslipTemplates.id],
  }),
  publishedByUser: one(users, {
    fields: [payslipPublications.publishedBy],
    references: [users.id],
    relationName: "payslipPublicationPublishedBy",
  }),
}));
