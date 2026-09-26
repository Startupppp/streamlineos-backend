import { index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const SUPPORT_KNOWLEDGE_GAP_STATUSES = [
  "OPEN",
  "DRAFTED",
  "ROUTED",
  "PUBLISHED",
  "DISMISSED",
] as const;

export const SupportKnowledgeGapStatus = {
  OPEN: "OPEN",
  DRAFTED: "DRAFTED",
  ROUTED: "ROUTED",
  PUBLISHED: "PUBLISHED",
  DISMISSED: "DISMISSED",
} as const;

export type SupportKnowledgeGapStatusType = (typeof SupportKnowledgeGapStatus)[keyof typeof SupportKnowledgeGapStatus];

export const supportKnowledgeGaps = pgTable(
  "support_knowledge_gaps",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    clusterKey: varchar("cluster_key", { length: 500 }).notNull(),
    representativeQuestion: text("representative_question").notNull(),
    ticketCount: integer("ticket_count").default(0).notNull(),
    sampleTicketIds: jsonb("sample_ticket_ids").$type<number[]>().default([]).notNull(),
    status: text("status").default("OPEN").notNull(),
    proposedArticleId: integer("proposed_article_id"),
    dismissalReason: text("dismissal_reason"),
    draftedBy: text("drafted_by").references(() => users.id, { onDelete: "set null" }),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    evidence: jsonb("evidence")
      .$type<{ searchQueries: Array<{ query: string; count: number }>; relatedTicketIds: number[] }>()
      .default({ searchQueries: [], relatedTicketIds: [] })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_knowledge_gaps_org_cluster").on(table.orgId, table.clusterKey),
    index("idx_support_knowledge_gaps_org_status_created").on(table.orgId, table.status, table.createdAt),
    unique("uniq_support_knowledge_gaps_org_id").on(table.orgId, table.id),
  ],
);

export const supportKnowledgeGapsRelations = relations(supportKnowledgeGaps, ({ one }) => ({
  organization: one(organizations, { fields: [supportKnowledgeGaps.orgId], references: [organizations.id] }),
  draftedByUser: one(users, { fields: [supportKnowledgeGaps.draftedBy], references: [users.id], relationName: "gap_drafter" }),
  reviewedByUser: one(users, { fields: [supportKnowledgeGaps.reviewedBy], references: [users.id], relationName: "gap_reviewer" }),
}));
