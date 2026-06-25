import { pgTable, text, serial, timestamp, boolean, jsonb, integer, date, index, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { documentTypeEnum, ackStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { departments } from "./employees";

export const richDocuments = pgTable("rich_documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  contentJson: jsonb("content_json"),
  templateType: text("template_type"),
  isPublished: boolean("is_published").default(false).notNull(),
  version: integer("version").default(1).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_rich_documents_org").on(table.orgId),
]);

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  type: documentTypeEnum("type").notNull(),
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
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.parentDocumentId], foreignColumns: [table.id] }).onDelete("cascade"),
  index("idx_documents_org_type").on(table.orgId, table.type),
  index("idx_documents_user").on(table.userId),
  index("idx_documents_expiry").on(table.expiryDate),
]);

export const handbookVersions = pgTable("handbook_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  version: text("version").notNull(),
  title: text("title").notNull().default(""),
  documentId: integer("document_id").references(() => richDocuments.id),
  documentUrl: text("document_url"),
  changelog: text("changelog"),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_handbook_org").on(table.orgId),
]);

export const policyAcknowledgments = pgTable("policy_acknowledgments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentId: integer("document_id").references(() => documents.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  status: ackStatusEnum("status").default("PENDING").notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
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
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_email_templates_org").on(table.orgId),
]);

export const careerLadders = pgTable("career_ladders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  department: text("department"),
  description: text("description"),
  levels: jsonb("levels").$type<{ level: number; title: string; description: string; minExperience: number; skills: string[] }[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_career_ladders_org").on(table.orgId),
]);

export const learningPaths = pgTable("learning_paths", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  targetRole: text("target_role"),
  level: text("level"),
  estimatedHours: integer("estimated_hours"),
  steps: jsonb("steps").$type<{ order: number; type: "assessment" | "certification"; referenceId: number; title: string }[]>(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_learning_paths_org").on(table.orgId),
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
  organizedBy: text("organized_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_team_events_org").on(table.orgId),
]);

export const teamEventParticipants = pgTable("team_event_participants", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => teamEvents.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  status: text("status").default("GOING").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

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

export const learningPathsRelations = relations(learningPaths, ({ one }) => ({
  creator: one(users, { fields: [learningPaths.createdBy], references: [users.id] }),
}));

export const teamEventsRelations = relations(teamEvents, ({ one, many }) => ({
  organizer: one(users, { fields: [teamEvents.organizedBy], references: [users.id] }),
  participants: many(teamEventParticipants),
}));

export const teamEventParticipantsRelations = relations(teamEventParticipants, ({ one }) => ({
  event: one(teamEvents, { fields: [teamEventParticipants.eventId], references: [teamEvents.id] }),
  user: one(users, { fields: [teamEventParticipants.userId], references: [users.id] }),
}));
