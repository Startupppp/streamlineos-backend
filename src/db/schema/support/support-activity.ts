import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { supportTickets } from "../crm/billing";
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
]);

export const supportTicketActivity = pgTable(
  "support_ticket_activity",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    supportTicketId: integer("support_ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id"),
    action: supportActivityActionEnum("action").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_support_ticket_activity_ticket").on(table.supportTicketId),
  ],
);

export const kbArticleComments = pgTable(
  "kb_article_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    parentId: integer("parent_id"),
    content: text("content").notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_article_comments_article").on(table.articleId),
    index("idx_kb_comments_org_article").on(table.orgId, table.articleId),
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
