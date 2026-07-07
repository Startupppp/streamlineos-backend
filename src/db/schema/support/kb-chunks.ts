import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { kbArticles } from "./kb";
import { kbArticleAttachments } from "./kb-attachments";
import { kbPages } from "../kb/pages";
import { kbSources } from "../kb/sources";

export const KB_CHUNK_SOURCES = ["article_body", "attachment", "page_body", "source"] as const;
export type KbChunkSource = (typeof KB_CHUNK_SOURCES)[number];

export const KB_EMBEDDING_DIMENSIONS = 1536;

export const kbArticleChunks = pgTable(
  "kb_article_chunks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }),
    pageId: integer("page_id").references(() => kbPages.id, { onDelete: "cascade" }),
    attachmentId: integer("attachment_id").references(
      () => kbArticleAttachments.id,
      { onDelete: "cascade" },
    ),
    sourceId: integer("source_id").references(() => kbSources.id, {
      onDelete: "cascade",
    }),
    source: text("source").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokens: integer("tokens"),
    embedding: vector("embedding", {
      dimensions: KB_EMBEDDING_DIMENSIONS,
    }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chunks_article").on(table.articleId),
    index("idx_kb_chunks_org_article").on(table.orgId, table.articleId),
    index("idx_kb_chunks_org_page").on(table.orgId, table.pageId),
    index("idx_kb_chunks_org_source").on(table.orgId, table.sourceId),
  ],
);

export const kbArticleChunksRelations = relations(kbArticleChunks, ({ one }) => ({
  article: one(kbArticles, {
    fields: [kbArticleChunks.articleId],
    references: [kbArticles.id],
  }),
  page: one(kbPages, {
    fields: [kbArticleChunks.pageId],
    references: [kbPages.id],
  }),
  attachment: one(kbArticleAttachments, {
    fields: [kbArticleChunks.attachmentId],
    references: [kbArticleAttachments.id],
  }),
  sourceDocument: one(kbSources, {
    fields: [kbArticleChunks.sourceId],
    references: [kbSources.id],
  }),
}));
