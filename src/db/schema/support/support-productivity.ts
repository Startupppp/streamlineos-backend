import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { supportTickets, supportTicketMessages } from "./tickets";

export const supportMessageMentions = pgTable(
  "support_message_mentions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    messageId: integer("message_id").references(() => supportTicketMessages.id, { onDelete: "cascade" }).notNull(),
    mentionedUserId: text("mentioned_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_message_mentions_message_user").on(table.messageId, table.mentionedUserId),
    index("idx_support_message_mentions_message").on(table.messageId),
    unique("uniq_support_message_mentions_org_id").on(table.orgId, table.id),
  ],
);

export const supportTicketDrafts = pgTable(
  "support_ticket_drafts",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    body: text("body").default("").notNull(),
    isInternal: boolean("is_internal").default(false).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_drafts_ticket_user").on(table.ticketId, table.userId),
    unique("uniq_support_ticket_drafts_org_id").on(table.orgId, table.id),
  ],
);
