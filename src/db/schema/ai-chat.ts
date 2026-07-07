import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

export const AI_CHAT_ROLES = ["user", "assistant"] as const;
export type AiChatRole = (typeof AI_CHAT_ROLES)[number];

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
    role: text("role").$type<AiChatRole>().notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_chat_messages_org_user_id").on(table.orgId, table.userId, table.id),
  ],
);

export const aiChatMessagesRelations = relations(aiChatMessages, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiChatMessages.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [aiChatMessages.userId],
    references: [users.id],
  }),
}));
