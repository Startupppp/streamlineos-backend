import { pgTable, serial, text, integer, timestamp, uniqueIndex, index, customType, vector } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "./auth";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const WORKSPACE_ENTITY_TYPES = ["project", "ticket", "lead", "deal", "contact", "client"] as const;
export type WorkspaceEntityType = (typeof WORKSPACE_ENTITY_TYPES)[number];

export const workspaceSearchChunks = pgTable(
  "workspace_search_chunks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    urlPath: text("url_path").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    fts: tsvector("fts"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_wsc_org_entity").on(table.orgId, table.entityType, table.entityId),
    index("idx_wsc_org_type").on(table.orgId, table.entityType),
  ],
);

export const workspaceSearchChunksRelations = relations(workspaceSearchChunks, ({ one }) => ({
  org: one(organizations, {
    fields: [workspaceSearchChunks.orgId],
    references: [organizations.id],
  }),
}));
