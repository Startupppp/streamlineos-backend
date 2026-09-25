import { pgTable, text, serial, timestamp, boolean, jsonb, integer, date, index, foreignKey, unique, uniqueIndex, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { documentTypeEnum, documentClassificationEnum, ackStatusEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";

export const richDocuments = pgTable("rich_documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  contentJson: jsonb("content_json"),
  templateType: text("template_type"),
  isPublished: boolean("is_published").default(false).notNull(),
  version: integer("version").default(1).notNull(),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_rich_documents_org_id").on(table.orgId, table.id),
  index("idx_rich_documents_org_updated").on(table.orgId, table.updatedAt),
]);

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id"),
  departmentId: text("department_id"),
  name: text("name").notNull(),
  description: text("description"),
  type: documentTypeEnum("type").notNull(),
  classification: documentClassificationEnum("classification").notNull().default("PERSONAL"),
  effectiveDate: date("effective_date"),
  category: text("category"),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  version: integer("version").default(1).notNull(),
  parentDocumentId: integer("parent_document_id"),
  isPublic: boolean("is_public").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  expiryDate: date("expiry_date"),
  expiryReminderSent: boolean("expiry_reminder_sent").default(false).notNull(),
  tags: text("tags").array().default([]).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  uploadedBy: text("uploaded_by"),
  userMembershipId: integer("user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.departmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_documents_department_id_org" }).onDelete("set null"),
  unique("uniq_documents_org_id").on(table.orgId, table.id),
  foreignKey({ columns: [table.orgId, table.parentDocumentId], foreignColumns: [table.orgId, table.id], name: "fk_documents_org_parent" }).onDelete("cascade"),
  index("idx_documents_org_type").on(table.orgId, table.type),
  index("idx_documents_user").on(table.userId),
  index("idx_documents_expiry").on(table.expiryDate),
  index("idx_documents_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_documents_user_actor",
  }).onDelete("set null"),
]);

// The ceiling on who may be shown a document: all employees, one department, or one location. No rows = HR-only.
export const documentAudiences = pgTable("document_audiences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentId: integer("document_id").notNull(),
  kind: text("kind").$type<"ALL_EMPLOYEES" | "DEPARTMENT" | "LOCATION">().notNull(),
  refId: text("ref_id"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("uniq_document_audiences_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_document_audiences_member").on(table.orgId, table.documentId, table.kind, sql`(coalesce(${table.refId}, ''))`),
  index("idx_document_audiences_org_kind_ref").on(table.orgId, table.kind, table.refId),
  index("idx_document_audiences_org_created_by_membership").on(table.orgId, table.createdByMembershipId),
  check("chk_document_audiences_kind", sql`${table.kind} IN ('ALL_EMPLOYEES', 'DEPARTMENT', 'LOCATION')`),
  check("chk_document_audiences_ref", sql`(${table.kind} = 'ALL_EMPLOYEES') = (${table.refId} IS NULL)`),
  foreignKey({ columns: [table.orgId, table.documentId], foreignColumns: [documents.orgId, documents.id], name: "fk_document_audiences_document_id_org" }).onDelete("cascade"),
  // Live constraint is `ON DELETE SET NULL (created_by_membership_id)`; drizzle-orm 0.45 cannot express the column list (see kb/pages.ts).
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_document_audiences_created_by_actor" }).onDelete("set null"),
]);

// File history. `documents` keeps the CURRENT APPROVED file, so every existing reader is unchanged; a pinned knowledge-base link resolves against this table.
export const documentVersions = pgTable("document_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentId: integer("document_id").notNull(),
  version: integer("version").notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  status: text("status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
  effectiveDate: date("effective_date"),
  uploadedByMembershipId: integer("uploaded_by_membership_id"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("uniq_document_versions_org_id").on(table.orgId, table.id),
  unique("uniq_document_versions_doc_version").on(table.orgId, table.documentId, table.version),
  index("idx_document_versions_org_uploaded_by_membership").on(table.orgId, table.uploadedByMembershipId),
  index("idx_document_versions_org_approved_by_membership").on(table.orgId, table.approvedByMembershipId),
  check("chk_document_versions_version_positive", sql`${table.version} >= 1`),
  check("chk_document_versions_status", sql`${table.status} IN ('pending', 'approved', 'rejected')`),
  check("chk_document_versions_approved_stamped", sql`${table.status} <> 'approved' OR ${table.approvedAt} IS NOT NULL`),
  foreignKey({ columns: [table.orgId, table.documentId], foreignColumns: [documents.orgId, documents.id], name: "fk_document_versions_document_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.uploadedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_document_versions_uploaded_by_actor" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.approvedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_document_versions_approved_by_actor" }).onDelete("set null"),
]);

export const handbookVersions = pgTable("handbook_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  version: text("version").notNull(),
  title: text("title").notNull().default(""),
  documentId: integer("document_id"),
  documentUrl: text("document_url"),
  changelog: text("changelog"),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.documentId], foreignColumns: [richDocuments.orgId, richDocuments.id], name: "fk_handbook_versions_document_id_org" }),
  unique("uniq_handbook_versions_org_id").on(table.orgId, table.id),
]);

export const policyAcknowledgments = pgTable("policy_acknowledgments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentId: integer("document_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  status: ackStatusEnum("status").default("PENDING").notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.documentId], foreignColumns: [documents.orgId, documents.id], name: "fk_policy_acknowledgments_document_id_org" }).onDelete("cascade"),
  unique("uniq_policy_acknowledgments_org_id").on(table.orgId, table.id),
  index("idx_policy_ack_doc").on(table.documentId),
  index("idx_policy_ack_user").on(table.userId),
]);

export const emailTemplates = pgTable("hr_email_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  category: text("category").default("GENERAL").notNull(),
  variables: text("variables").array(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_email_templates_org_id").on(table.orgId, table.id),
]);

export const teamEvents = pgTable("team_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").default("TEAM_BUILDING").notNull(),
  date: date("date").notNull(),
  time: text("time"),
  location: text("location"),
  maxParticipants: integer("max_participants"),
  organizedBy: text("organized_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_team_events_org_id").on(table.orgId, table.id),
]);

export const teamEventParticipants = pgTable("team_event_participants", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  eventId: integer("event_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  status: text("status").default("GOING").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.eventId], foreignColumns: [teamEvents.orgId, teamEvents.id], name: "fk_team_event_participants_event_id_org" }).onDelete("cascade"),
  index("idx_team_event_participants_org_event_user").on(table.orgId, table.eventId, table.userId),
]);

export const richDocumentsRelations = relations(richDocuments, ({ one }) => ({
  organization: one(organizations, { fields: [richDocuments.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [richDocuments.createdBy], references: [users.id] }),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  user: one(users, { fields: [documents.userId], references: [users.id] }),
  uploader: one(users, { fields: [documents.uploadedBy], references: [users.id], relationName: "documentUploader" }),
  parent: one(documents, { fields: [documents.parentDocumentId], references: [documents.id] }),
}));

export const handbookVersionsRelations = relations(handbookVersions, ({ one }) => ({
  document: one(richDocuments, { fields: [handbookVersions.documentId], references: [richDocuments.id] }),
  publisher: one(users, { fields: [handbookVersions.publishedBy], references: [users.id] }),
}));

export const policyAcknowledgmentsRelations = relations(policyAcknowledgments, ({ one }) => ({
  document: one(documents, { fields: [policyAcknowledgments.documentId], references: [documents.id] }),
  user: one(users, { fields: [policyAcknowledgments.userId], references: [users.id] }),
}));

export const emailTemplatesRelations = relations(emailTemplates, ({ one }) => ({
  creator: one(users, { fields: [emailTemplates.createdBy], references: [users.id] }),
}));

export const teamEventsRelations = relations(teamEvents, ({ one, many }) => ({
  organizer: one(users, { fields: [teamEvents.organizedBy], references: [users.id] }),
  participants: many(teamEventParticipants),
}));

export const teamEventParticipantsRelations = relations(teamEventParticipants, ({ one }) => ({
  event: one(teamEvents, { fields: [teamEventParticipants.eventId], references: [teamEvents.id] }),
  user: one(users, { fields: [teamEventParticipants.userId], references: [users.id] }),
}));
