import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  vector,
  pgEnum,
} from "drizzle-orm/pg-core";
import { organizations } from "../auth";
import { supportTickets } from "../crm/billing";
import { users } from "../auth";

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
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
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
    index("idx_support_ai_suggestions_ticket").on(table.ticketId),
    index("idx_support_ai_suggestions_org_type").on(table.orgId, table.type),
    index("idx_support_ai_suggestions_status").on(table.status),
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
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    embedding: vector("embedding", { dimensions: SUPPORT_AI_EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("idx_support_ticket_embeddings_ticket").on(table.ticketId),
    index("idx_support_ticket_embeddings_org").on(table.orgId),
  ],
);
