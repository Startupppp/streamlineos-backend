import {
  pgTable,
  bigint,
  serial,
  text,
  integer,
  timestamp,
  index,
  vector,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { kbPageAttachments } from "../kb/attachments";
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
    pageId: integer("page_id"),
    attachmentId: bigint("attachment_id", { mode: "number" }),
    sourceId: integer("source_id"),
    source: text("source").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash"),
    tokens: integer("tokens"),
    embedding: vector("embedding", {
      dimensions: KB_EMBEDDING_DIMENSIONS,
    }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    pageVisibility: text("page_visibility"),
    pageProjectId: integer("page_project_id"),
    pageCreatedById: text("page_created_by_id"),
    pageCreatedByMembershipId: integer("page_created_by_membership_id"),
    aclRevision: integer("acl_revision").notNull().default(1),
    contentRevision: integer("content_revision"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chunks_org_page").on(table.orgId, table.pageId),
    index("idx_kb_chunks_org_source").on(table.orgId, table.sourceId),
    index("idx_kb_chunks_org_page_acl")
      .on(
        table.orgId,
        table.pageVisibility,
        table.pageProjectId,
        table.pageCreatedById,
        table.pageCreatedByMembershipId,
      )
      .where(sql`page_id IS NOT NULL`),
    index("idx_kb_chunks_embedding_hnsw").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    unique("uniq_kb_article_chunks_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.pageId], foreignColumns: [kbPages.orgId, kbPages.id], name: "fk_kb_chunks_org_page" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.attachmentId], foreignColumns: [kbPageAttachments.orgId, kbPageAttachments.id], name: "fk_kb_chunks_org_attachment" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.sourceId], foreignColumns: [kbSources.orgId, kbSources.id], name: "fk_kb_chunks_org_source" }).onDelete("cascade"),
  ],
);

export const kbArticleChunksRelations = relations(kbArticleChunks, ({ one }) => ({
  page: one(kbPages, {
    fields: [kbArticleChunks.pageId],
    references: [kbPages.id],
  }),
  attachment: one(kbPageAttachments, {
    fields: [kbArticleChunks.attachmentId],
    references: [kbPageAttachments.id],
  }),
  sourceDocument: one(kbSources, {
    fields: [kbArticleChunks.sourceId],
    references: [kbSources.id],
  }),
}));
