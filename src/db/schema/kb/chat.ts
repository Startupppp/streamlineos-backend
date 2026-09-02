import { pgTable, serial, text, jsonb, timestamp, index, integer, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";

export const KB_CHAT_ROLES = ["user", "assistant"] as const;
export type KbChatRole = (typeof KB_CHAT_ROLES)[number];

export type KbChatCitation =
  | { kind: "article"; articleId: number; title: string; slug: string; spaceId: number | null }
  | { kind: "page"; pageId: number; title: string; spaceId: number | null }
  | { kind: "source"; sourceId: number; title: string; spaceId: number | null };

export const kbChatConversations = pgTable(
  "kb_chat_conversations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_kb_chat_conversations_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_chat_conv_org_user_mbr" }).onDelete("cascade"),
  ],
);

export const kbChatMessages = pgTable(
  "kb_chat_messages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id").notNull(),
    role: text("role").$type<KbChatRole>().notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<KbChatCitation[]>(),
    conversationId: integer("conversation_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chat_messages_org_mbr").on(table.orgId, table.userMembershipId),
    index("idx_kb_chat_messages_conversation_id").on(table.conversationId),
    unique("uniq_kb_chat_messages_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.conversationId], foreignColumns: [kbChatConversations.orgId, kbChatConversations.id], name: "fk_kb_chat_messages_org_conversation" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_chat_msg_org_user_mbr" }).onDelete("cascade"),
  ],
);

export const kbChatConversationsRelations = relations(kbChatConversations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [kbChatConversations.orgId],
    references: [organizations.id],
  }),
  membership: one(organizationMembers, {
    fields: [kbChatConversations.orgId, kbChatConversations.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  messages: many(kbChatMessages),
}));

export const kbChatMessagesRelations = relations(kbChatMessages, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbChatMessages.orgId],
    references: [organizations.id],
  }),
  membership: one(organizationMembers, {
    fields: [kbChatMessages.orgId, kbChatMessages.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  conversation: one(kbChatConversations, {
    fields: [kbChatMessages.conversationId],
    references: [kbChatConversations.id],
  }),
}));
