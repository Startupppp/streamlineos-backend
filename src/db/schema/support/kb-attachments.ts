import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { kbArticles } from "./kb";

export const kbArticleAttachments = pgTable(
  "kb_article_attachments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    fileName: text("file_name").notNull(),
    fileKey: text("file_key").notNull(),
    fileUrl: text("file_url"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_article_attachments_article").on(table.articleId),
  ],
);

export const kbArticleAttachmentsRelations = relations(kbArticleAttachments, ({ one }) => ({
  article: one(kbArticles, {
    fields: [kbArticleAttachments.articleId],
    references: [kbArticles.id],
  }),
}));
