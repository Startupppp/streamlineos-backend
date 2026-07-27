import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { kbPages, type KbPageContent } from "./pages";

export const kbPageVersions = pgTable(
  "kb_page_versions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull().default(""),
    content: jsonb("content").$type<KbPageContent>(),
    contentText: text("content_text"),
    changeSummary: text("change_summary"),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_versions_page_version").on(table.pageId, table.versionNumber),
    index("idx_kb_page_versions_org_page").on(table.orgId, table.pageId),
    unique("uniq_kb_page_versions_org_id").on(table.orgId, table.id),
  ],
);

export const kbPageComments = pgTable(
  "kb_page_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    parentId: integer("parent_id"),
    content: text("content").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_page_comments_org_page").on(table.orgId, table.pageId),
    index("idx_kb_page_comments_parent").on(table.parentId),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "fk_kb_page_comments_parent",
    }).onDelete("cascade"),
    unique("uniq_kb_page_comments_org_id").on(table.orgId, table.id),
  ],
);

export const kbPageTemplates = pgTable(
  "kb_page_templates",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    description: text("description"),
    content: jsonb("content").$type<KbPageContent>(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_page_templates_org").on(table.orgId),
    unique("uniq_kb_page_templates_org_id").on(table.orgId, table.id),
  ],
);

export const kbPageVersionsRelations = relations(kbPageVersions, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageVersions.pageId], references: [kbPages.id] }),
  author: one(users, { fields: [kbPageVersions.authorId], references: [users.id] }),
}));

export const kbPageCommentsRelations = relations(kbPageComments, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageComments.pageId], references: [kbPages.id] }),
  author: one(users, { fields: [kbPageComments.authorId], references: [users.id] }),
}));

export const kbPageTemplatesRelations = relations(kbPageTemplates, ({ one }) => ({
  createdBy: one(users, { fields: [kbPageTemplates.createdById], references: [users.id] }),
  organization: one(organizations, { fields: [kbPageTemplates.orgId], references: [organizations.id] }),
}));
