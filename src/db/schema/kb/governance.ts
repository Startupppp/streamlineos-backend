import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { kbPages } from "./pages";

export const kbPageReviews = pgTable(
  "kb_page_reviews",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pageId: integer("page_id")
      .references(() => kbPages.id, { onDelete: "cascade" })
      .notNull(),
    type: text("type").$type<"approval" | "freshness">().notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "rejected" | "expired">()
      .notNull()
      .default("pending"),
    requestedById: text("requested_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewerId: text("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_page_reviews_org_status_due").on(table.orgId, table.status, table.dueAt),
    index("idx_kb_page_reviews_org_page").on(table.orgId, table.pageId),
    unique("uniq_kb_page_reviews_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.pageId], foreignColumns: [kbPages.orgId, kbPages.id], name: "fk_kb_page_reviews_org_page" }),
  ],
);

export const kbImportJobs = pgTable(
  "kb_import_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sourceType: text("source_type").$type<"markdown" | "html" | "zip" | "support_kb">().notNull(),
    fileKey: text("file_key"),
    status: text("status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    totalItems: integer("total_items").notNull().default(0),
    processedItems: integer("processed_items").notNull().default(0),
    succeededItems: integer("succeeded_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    duplicateItems: integer("duplicate_items").notNull().default(0),
    errorReport: jsonb("error_report").$type<Record<string, unknown>>(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_import_jobs_org_created").on(table.orgId, table.createdAt),
    unique("uniq_kb_import_jobs_org_id").on(table.orgId, table.id),
  ],
);

export const kbExportJobs = pgTable(
  "kb_export_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    scopeType: text("scope_type").$type<"page" | "all">().notNull(),
    scopeId: integer("scope_id"),
    format: text("format").$type<"markdown" | "html">().notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    fileKey: text("file_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_export_jobs_org_created").on(table.orgId, table.createdAt),
    unique("uniq_kb_export_jobs_org_id").on(table.orgId, table.id),
  ],
);

export const kbPageReviewsRelations = relations(kbPageReviews, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbPageReviews.orgId],
    references: [organizations.id],
  }),
  page: one(kbPages, {
    fields: [kbPageReviews.pageId],
    references: [kbPages.id],
  }),
  requestedBy: one(users, {
    fields: [kbPageReviews.requestedById],
    references: [users.id],
    relationName: "review_requested_by",
  }),
  reviewer: one(users, {
    fields: [kbPageReviews.reviewerId],
    references: [users.id],
    relationName: "review_reviewer",
  }),
}));

export const kbImportJobsRelations = relations(kbImportJobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbImportJobs.orgId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [kbImportJobs.createdById],
    references: [users.id],
  }),
}));

export const kbExportJobsRelations = relations(kbExportJobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbExportJobs.orgId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [kbExportJobs.createdById],
    references: [users.id],
  }),
}));
