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
import { kbChatConversations, kbChatMessages } from "./chat";

export const KB_AI_INTERACTION_STATES = [
  "answered",
  "no_context",
  "credits_exhausted",
  "provider_unavailable",
  "error",
] as const;
export type KbAiInteractionState = (typeof KB_AI_INTERACTION_STATES)[number];

export interface KbAiSourceRecord {
  kind: "article" | "page" | "source" | "document";
  id: number;
  aclRevision: number | null;
}

export const kbAiInteractions = pgTable(
  "kb_ai_interactions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    correlationId: text("correlation_id").notNull(),
    actorMembershipId: integer("actor_membership_id"),
    conversationId: integer("conversation_id"),
    messageId: integer("message_id"),
    provider: text("provider"),
    model: text("model"),
    promptPolicyVersion: integer("prompt_policy_version"),
    sourceIdsWithRevisions: jsonb("source_ids_with_revisions").$type<KbAiSourceRecord[]>(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    latencyMs: integer("latency_ms"),
    resultState: text("result_state").$type<KbAiInteractionState>().notNull(),
    feedback: text("feedback"),
    costCredits: integer("cost_credits"),
    gatewayCorrelationId: text("gateway_correlation_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_ai_interactions_org_time").on(table.orgId, table.createdAt),
    index("idx_kb_ai_interactions_org_actor").on(table.orgId, table.actorMembershipId),
    index("idx_kb_ai_interactions_org_conversation").on(table.orgId, table.conversationId),
    index("idx_kb_ai_interactions_org_correlation").on(table.orgId, table.correlationId),
    unique("uniq_kb_ai_interactions_org_correlation").on(table.orgId, table.correlationId),
    unique("uniq_kb_ai_interactions_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.actorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_ai_interactions_org_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.conversationId],
      foreignColumns: [kbChatConversations.orgId, kbChatConversations.id],
      name: "fk_kb_ai_interactions_org_conversation",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [kbChatMessages.orgId, kbChatMessages.id],
      name: "fk_kb_ai_interactions_org_message",
    }).onDelete("set null"),
  ],
);

export const kbAiInteractionsRelations = relations(kbAiInteractions, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbAiInteractions.orgId],
    references: [organizations.id],
  }),
  actorMembership: one(organizationMembers, {
    fields: [kbAiInteractions.orgId, kbAiInteractions.actorMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  conversation: one(kbChatConversations, {
    fields: [kbAiInteractions.orgId, kbAiInteractions.conversationId],
    references: [kbChatConversations.orgId, kbChatConversations.id],
  }),
  message: one(kbChatMessages, {
    fields: [kbAiInteractions.orgId, kbAiInteractions.messageId],
    references: [kbChatMessages.orgId, kbChatMessages.id],
  }),
}));
