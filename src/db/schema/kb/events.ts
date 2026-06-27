import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbArticles } from "../support/kb";

export const KB_EVENT_TYPES = [
  "view",
  "search",
  "search_no_results",
  "helpful_vote",
  "ai_answer",
  "ticket_deflected",
] as const;
export type KbEventType = (typeof KB_EVENT_TYPES)[number];

export const kbEvents = pgTable(
  "kb_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "set null" }),
    query: text("query"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_events_org_time").on(table.orgId, table.occurredAt),
    index("idx_kb_events_org_type").on(table.orgId, table.eventType),
    index("idx_kb_events_org_type_time").on(table.orgId, table.eventType, table.occurredAt),
  ],
);

export const kbEventsRelations = relations(kbEvents, ({ one }) => ({
  organization: one(organizations, { fields: [kbEvents.orgId], references: [organizations.id] }),
  article: one(kbArticles, { fields: [kbEvents.articleId], references: [kbArticles.id] }),
}));
