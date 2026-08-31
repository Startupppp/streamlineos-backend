import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
  vector,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { KB_EMBEDDING_DIMENSIONS } from "./kb-chunks";

export const kbIngestionCheckpoints = pgTable(
  "kb_ingestion_checkpoints",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    contentType: text("content_type").notNull(),
    contentId: integer("content_id").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: KB_EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_kb_ingestion_checkpoint").on(
      table.orgId,
      table.contentType,
      table.contentId,
      table.chunkIndex,
    ),
    index("idx_kb_ingestion_checkpoint_lookup").on(
      table.orgId,
      table.contentType,
      table.contentId,
      table.contentHash,
    ),
  ],
);
