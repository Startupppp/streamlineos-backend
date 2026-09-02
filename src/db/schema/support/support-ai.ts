import { foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex, vector } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { supportTickets } from "./tickets";

export const SUPPORT_AI_EMBEDDING_DIMENSIONS = 1536;

export const supportSuggestionTypeEnum = pgEnum("support_suggestion_type", [
  "summary",
  "sentiment",
  "category",
  "priority",
  "spam",
  "reply",
  "macro",
  "kb_article",
  "duplicate",
  "handoff_summary",
  "root_cause_cluster",
]);

export const supportSuggestionStatusEnum = pgEnum("support_suggestion_status", [
  "pending",
  "accepted",
  "rejected",
]);

export const supportAiSuggestions = pgTable(
  "support_ai_suggestions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").notNull(),
    type: supportSuggestionTypeEnum("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    status: supportSuggestionStatusEnum("status").default("pending").notNull(),
    feedback: text("feedback"),
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: text("resolved_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ai_suggestions_ticket_id_org" }).onDelete("cascade"),
    index("idx_support_ai_suggestions_ticket").on(table.ticketId),
    index("idx_support_ai_suggestions_org_type").on(table.orgId, table.type),
    index("idx_support_ai_suggestions_status").on(table.status),
    unique("uniq_support_ai_suggestions_org_id").on(table.orgId, table.id),
  ],
);

export const supportAiSettings = pgTable(
  "support_ai_settings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    confidenceThreshold: numeric("confidence_threshold", { precision: 4, scale: 3 }).default("0.7").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_ai_settings_org").on(table.orgId),
    unique("uniq_support_ai_settings_org_id").on(table.orgId, table.id),
  ],
);

// One embedding per ticket (title + description), regenerated on update. Used for
// duplicate-ticket detection via pgvector cosine distance — not chunked like KB
// articles since a ticket's identifying text is short enough for a single vector.
export const supportTicketEmbeddings = pgTable(
  "support_ticket_embeddings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").notNull(),
    embedding: vector("embedding", { dimensions: SUPPORT_AI_EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ticket_embeddings_ticket_id_org" }).onDelete("cascade"),
    uniqueIndex("idx_support_ticket_embeddings_ticket").on(table.ticketId),
    index("idx_support_ticket_embeddings_org").on(table.orgId),
    unique("uniq_support_ticket_embeddings_org_id").on(table.orgId, table.id),
  ],
);
