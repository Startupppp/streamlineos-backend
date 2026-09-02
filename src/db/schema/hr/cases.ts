import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../common/auth";
import { hrTemplateRenders } from "./template-engine";

export const hrCaseCategoryEnum = pgEnum("hr_case_category", [
  "grievance",
  "disciplinary",
  "harassment",
  "ethics",
  "performance",
  "workplace_conflict",
  "policy_violation",
  "other",
]);

export const hrCaseSeverityEnum = pgEnum("hr_case_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const hrCaseStatusEnum = pgEnum("hr_case_status", [
  "open",
  "under_investigation",
  "resolved",
  "closed",
  "dismissed",
]);

export const hrDisciplinaryActionTypeEnum = pgEnum("hr_disciplinary_action_type", [
  "verbal_warning",
  "written_warning",
  "final_warning",
  "suspension",
  "termination_recommended",
]);

export const hrCases = pgTable("hr_cases", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  caseNumber: text("case_number").notNull(),
  category: hrCaseCategoryEnum("category").notNull(),
  subjectEmployeeId: text("subject_employee_id").references(() => users.id, { onDelete: "set null" }),
  reportedBy: text("reported_by"),
  anonymous: boolean("anonymous").default(false).notNull(),
  confidential: boolean("confidential").default(true).notNull(),
  severity: hrCaseSeverityEnum("severity").notNull(),
  status: hrCaseStatusEnum("status").default("open").notNull(),
  summary: text("summary").notNull(),
  details: text("details").notNull(),
  outcome: text("outcome"),
  resolvedAt: timestamp("resolved_at"),
  assignedTo: text("assigned_to"),
  assignedToMembershipId: integer("assigned_to_membership_id"),
  reportedByMembershipId: integer("reported_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  unique("uniq_hr_cases_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_cases_org_number").on(table.orgId, table.caseNumber),
  index("idx_hr_cases_org_status").on(table.orgId, table.status),
  index("idx_hr_cases_org_category").on(table.orgId, table.category),
  index("idx_hr_cases_org_assigned").on(table.orgId, table.assignedTo),
  index("idx_hr_cases_org_assigned_membership").on(table.orgId, table.assignedToMembershipId),
  index("idx_hr_cases_org_reported_membership").on(table.orgId, table.reportedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.assignedToMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_cases_assigned_to_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.reportedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_cases_reported_by_actor",
  }).onDelete("set null"),
]);

export const hrCaseNotes = pgTable("hr_case_notes", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  authorMembershipId: integer("author_membership_id"),
  note: text("note").notNull(),
  isConfidential: boolean("is_confidential").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.caseId], foreignColumns: [hrCases.orgId, hrCases.id], name: "fk_hr_case_notes_org_case" }).onDelete("cascade"),
  unique("uniq_hr_case_notes_org_id").on(table.orgId, table.id),
  index("idx_hr_case_notes_case").on(table.caseId),
  index("idx_hr_case_notes_org").on(table.orgId),
  index("idx_hr_case_notes_org_author_membership").on(table.orgId, table.authorMembershipId),
  foreignKey({
    columns: [table.orgId, table.authorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_case_notes_author_actor",
  }).onDelete("set null"),
]);

export const hrCaseDocuments = pgTable("hr_case_documents", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  restricted: boolean("restricted").default(false).notNull(),
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.caseId], foreignColumns: [hrCases.orgId, hrCases.id], name: "fk_hr_case_documents_org_case" }).onDelete("cascade"),
  unique("uniq_hr_case_documents_org_id").on(table.orgId, table.id),
  index("idx_hr_case_documents_case").on(table.caseId),
]);

export const hrDisciplinaryActions = pgTable("hr_disciplinary_actions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  caseId: integer("case_id"),
  employeeId: text("employee_id").notNull(),
  employeeMembershipId: integer("employee_membership_id"),
  actionType: hrDisciplinaryActionTypeEnum("action_type").notNull(),
  letterRenderId: integer("letter_render_id"),
  effectiveDate: timestamp("effective_date").notNull(),
  issuedBy: text("issued_by").references(() => users.id, { onDelete: "set null" }).notNull(),
  note: text("note"),
  acknowledgedAt: timestamp("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.caseId], foreignColumns: [hrCases.orgId, hrCases.id], name: "fk_hr_disciplinary_actions_org_case" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.letterRenderId], foreignColumns: [hrTemplateRenders.orgId, hrTemplateRenders.id], name: "fk_hr_disciplinary_actions_letter_render_id_org" }).onDelete("set null"),
  unique("uniq_hr_disciplinary_actions_org_id").on(table.orgId, table.id),
  index("idx_hr_disciplinary_org_employee").on(table.orgId, table.employeeId),
  index("idx_hr_disciplinary_org_employee_membership").on(table.orgId, table.employeeMembershipId),
  index("idx_hr_disciplinary_org_case").on(table.orgId, table.caseId),
  foreignKey({
    columns: [table.orgId, table.employeeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_disciplinary_actions_employee_actor",
  }).onDelete("set null"),
]);

export const hrCasesRelations = relations(hrCases, ({ one, many }) => ({
  org: one(organizations, { fields: [hrCases.orgId], references: [organizations.id] }),
  subjectEmployee: one(users, { fields: [hrCases.subjectEmployeeId], references: [users.id], relationName: "case_subject" }),
  reporter: one(users, { fields: [hrCases.reportedBy], references: [users.id], relationName: "case_reporter" }),
  assignee: one(users, { fields: [hrCases.assignedTo], references: [users.id], relationName: "case_assignee" }),
  notes: many(hrCaseNotes),
  documents: many(hrCaseDocuments),
  disciplinaryActions: many(hrDisciplinaryActions),
}));

export const hrCaseNotesRelations = relations(hrCaseNotes, ({ one }) => ({
  case: one(hrCases, { fields: [hrCaseNotes.caseId], references: [hrCases.id] }),
  author: one(users, { fields: [hrCaseNotes.authorId], references: [users.id] }),
}));

export const hrCaseDocumentsRelations = relations(hrCaseDocuments, ({ one }) => ({
  case: one(hrCases, { fields: [hrCaseDocuments.caseId], references: [hrCases.id] }),
  uploader: one(users, { fields: [hrCaseDocuments.uploadedBy], references: [users.id] }),
}));

export const hrDisciplinaryActionsRelations = relations(hrDisciplinaryActions, ({ one }) => ({
  org: one(organizations, { fields: [hrDisciplinaryActions.orgId], references: [organizations.id] }),
  case: one(hrCases, { fields: [hrDisciplinaryActions.caseId], references: [hrCases.id] }),
  employee: one(users, { fields: [hrDisciplinaryActions.employeeId], references: [users.id], relationName: "disciplinary_employee" }),
  issuedByUser: one(users, { fields: [hrDisciplinaryActions.issuedBy], references: [users.id], relationName: "disciplinary_issuer" }),
}));
