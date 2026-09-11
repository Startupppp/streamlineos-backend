import {
  pgTable,
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
import { kbArticles } from "./kb";

export const kbArticleAttachments = pgTable(
  "kb_article_attachments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").notNull(),
    fileName: text("file_name").notNull(),
    fileKey: text("file_key").notNull(),
    fileUrl: text("file_url"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_article_attachments_article").on(table.articleId),
    unique("uniq_kb_article_attachments_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_article_attachments_org_article" }).onDelete("cascade"),
  ],
);

export const kbArticleAttachmentsRelations = relations(kbArticleAttachments, ({ one }) => ({
  article: one(kbArticles, {
    fields: [kbArticleAttachments.articleId],
    references: [kbArticles.id],
  }),
}));
