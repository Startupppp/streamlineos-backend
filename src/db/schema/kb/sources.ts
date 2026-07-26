import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbSpaces } from "./spaces";

export const KB_SOURCE_KINDS = ["file", "note"] as const;
export type KbSourceKind = (typeof KB_SOURCE_KINDS)[number];

export const KB_SOURCE_STATUSES = ["processing", "ready", "failed"] as const;
export type KbSourceStatus = (typeof KB_SOURCE_STATUSES)[number];

export const kbSources = pgTable(
  "kb_sources",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    spaceId: integer("space_id").references(() => kbSpaces.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<KbSourceKind>().notNull(),
    title: text("title").notNull(),
    fileKey: text("file_key"),
    fileUrl: text("file_url"),
    mimeType: text("mime_type"),
    fileSize: integer("file_size"),
    noteText: text("note_text"),
    status: text("status").$type<KbSourceStatus>().notNull().default("processing"),
    chunkCount: integer("chunk_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdById: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_kb_sources_org").on(table.orgId),
    index("idx_kb_sources_org_space").on(table.orgId, table.spaceId),
    unique("uniq_kb_sources_org_id").on(table.orgId, table.id),
  ],
);

export const kbSourcesRelations = relations(kbSources, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbSources.orgId],
    references: [organizations.id],
  }),
  space: one(kbSpaces, {
    fields: [kbSources.spaceId],
    references: [kbSpaces.id],
  }),
  createdBy: one(users, {
    fields: [kbSources.createdById],
    references: [users.id],
  }),
}));
