import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { kbArticles } from "../support/kb";

export const KB_EVENT_TYPES = [
  "view",
  "search",
  "search_no_results",
  "helpful_vote",
  "ai_answer",
  "ai_answer_no_context",
  "ticket_deflected",
  "ai_feedback",
  "research_brief_requested",
] as const;
export type KbEventType = (typeof KB_EVENT_TYPES)[number];

export const kbEvents = pgTable(
  "kb_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    eventType: text("event_type").notNull(),
    actorMembershipId: integer("actor_membership_id"),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "set null" }),
    query: text("query"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_events_org_time").on(table.orgId, table.occurredAt),
    index("idx_kb_events_org_type").on(table.orgId, table.eventType),
    index("idx_kb_events_org_type_time").on(table.orgId, table.eventType, table.occurredAt),
    index("idx_kb_events_org_actor_membership").on(table.orgId, table.actorMembershipId),
    unique("uniq_kb_events_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_events_org_article" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.actorMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_events_org_actor_membership" }).onDelete("set null"),
  ],
);

export const kbEventsRelations = relations(kbEvents, ({ one }) => ({
  organization: one(organizations, { fields: [kbEvents.orgId], references: [organizations.id] }),
  article: one(kbArticles, { fields: [kbEvents.articleId], references: [kbArticles.id] }),
  actorMembership: one(organizationMembers, { fields: [kbEvents.actorMembershipId], references: [organizationMembers.id] }),
}));
