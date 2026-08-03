import { pgTable, serial, text, jsonb, timestamp, index, integer, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

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
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chat_conversations_org_user_updated").on(table.orgId, table.userId, table.updatedAt),
    unique("uniq_kb_chat_conversations_org_id").on(table.orgId, table.id),
  ],
);

export const kbChatMessages = pgTable(
  "kb_chat_messages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").$type<KbChatRole>().notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<KbChatCitation[]>(),
    conversationId: integer("conversation_id").references(() => kbChatConversations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chat_messages_org_user_id").on(table.orgId, table.userId, table.id),
    index("idx_kb_chat_messages_conversation_id").on(table.conversationId),
    unique("uniq_kb_chat_messages_org_id").on(table.orgId, table.id),
  ],
);

export const kbChatConversationsRelations = relations(kbChatConversations, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [kbChatConversations.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [kbChatConversations.userId],
    references: [users.id],
  }),
  messages: many(kbChatMessages),
}));

export const kbChatMessagesRelations = relations(kbChatMessages, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbChatMessages.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [kbChatMessages.userId],
    references: [users.id],
  }),
  conversation: one(kbChatConversations, {
    fields: [kbChatMessages.conversationId],
    references: [kbChatConversations.id],
  }),
}));
