import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { supportTickets } from "./tickets";
import { kbArticles } from "./kb";

export const supportActivityActionEnum = pgEnum("support_activity_action", [
  "created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "replied",
  "internal_note",
  "resolved",
  "reopened",
  "merged",
  "linked",
  "split",
  "snoozed",
  "unsnoozed",
]);

export const supportTicketActivity = pgTable(
  "support_ticket_activity",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    supportTicketId: integer("support_ticket_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: supportActivityActionEnum("action").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.supportTicketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ticket_activity_support_ticket_id_org" }).onDelete("cascade"),
    index("idx_support_ticket_activity_ticket").on(table.supportTicketId),
    unique("uniq_support_ticket_activity_org_id").on(table.orgId, table.id),
  ],
);

export const kbArticleComments = pgTable(
  "kb_article_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    parentId: integer("parent_id"),
    content: text("content").notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_article_comments_article_id_org" }).onDelete("cascade"),
    index("idx_kb_article_comments_article").on(table.articleId),
    index("idx_kb_comments_org_article").on(table.orgId, table.articleId),
    foreignKey({ columns: [table.orgId, table.parentId], foreignColumns: [table.orgId, table.id], name: "fk_kb_article_comments_org_parent" }).onDelete("cascade"),
    unique("uniq_kb_article_comments_org_id").on(table.orgId, table.id),
  ],
);

export const supportTicketActivityRelations = relations(supportTicketActivity, ({ one }) => ({
  organization: one(organizations, { fields: [supportTicketActivity.orgId], references: [organizations.id] }),
  ticket: one(supportTickets, { fields: [supportTicketActivity.supportTicketId], references: [supportTickets.id] }),
  user: one(users, { fields: [supportTicketActivity.userId], references: [users.id] }),
}));

export const kbArticleCommentsRelations = relations(kbArticleComments, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleComments.articleId], references: [kbArticles.id] }),
  author: one(users, { fields: [kbArticleComments.authorId], references: [users.id] }),
}));
