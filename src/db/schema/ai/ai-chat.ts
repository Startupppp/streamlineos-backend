import { pgTable, serial, text, timestamp, index, integer, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";

export const AI_CHAT_ROLES = ["user", "assistant"] as const;
export type AiChatRole = (typeof AI_CHAT_ROLES)[number];

export const aiChatConversations = pgTable(
  "ai_chat_conversations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id"),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_chat_conversations_org_user_updated").on(table.orgId, table.userId, table.updatedAt),
    unique("uniq_ai_chat_conversations_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ai_chat_conv_org_user_mbr",
    }).onDelete("set null"),
  ],
);

export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id"),
    role: text("role").$type<AiChatRole>().notNull(),
    content: text("content").notNull(),
    conversationId: integer("conversation_id").references(() => aiChatConversations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_chat_messages_org_user_id").on(table.orgId, table.userId, table.id),
    index("idx_ai_chat_messages_conversation_id").on(table.conversationId),
    unique("uniq_ai_chat_messages_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ai_chat_msg_org_user_mbr",
    }).onDelete("set null"),
  ],
);

export const aiChatConversationsRelations = relations(aiChatConversations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [aiChatConversations.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [aiChatConversations.userId],
    references: [users.id],
  }),
  messages: many(aiChatMessages),
}));

export const aiChatMessagesRelations = relations(aiChatMessages, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiChatMessages.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [aiChatMessages.userId],
    references: [users.id],
  }),
  conversation: one(aiChatConversations, {
    fields: [aiChatMessages.conversationId],
    references: [aiChatConversations.id],
  }),
}));
