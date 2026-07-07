import { pgTable, serial, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const KB_CHAT_ROLES = ["user", "assistant"] as const;
export type KbChatRole = (typeof KB_CHAT_ROLES)[number];

export type KbChatCitation =
  | { kind: "article"; articleId: number; title: string; slug: string; spaceId: number | null }
  | { kind: "page"; pageId: number; title: string; spaceId: number | null }
  | { kind: "source"; sourceId: number; title: string; spaceId: number | null };

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_chat_messages_org_user_id").on(table.orgId, table.userId, table.id),
  ],
);

export const kbChatMessagesRelations = relations(kbChatMessages, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbChatMessages.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [kbChatMessages.userId],
    references: [users.id],
  }),
}));
