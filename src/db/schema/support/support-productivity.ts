import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { supportTickets, supportTicketMessages } from "./tickets";

export const supportMessageMentions = pgTable(
  "support_message_mentions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    messageId: integer("message_id").references(() => supportTicketMessages.id, { onDelete: "cascade" }).notNull(),
    mentionedUserMembershipId: integer("mentioned_user_membership_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_message_mentions_message_membership").on(table.messageId, table.mentionedUserMembershipId),
    index("idx_support_message_mentions_message").on(table.messageId),
    unique("uniq_support_message_mentions_org_id").on(table.orgId, table.id),
    index("idx_support_message_mentions_org_mentioned_actor").on(table.orgId, table.mentionedUserMembershipId),
    foreignKey({
      columns: [table.orgId, table.mentionedUserMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_message_mentions_mentioned_actor",
    }).onDelete("cascade"),
  ],
);

export const supportTicketDrafts = pgTable(
  "support_ticket_drafts",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").notNull(),
    userMembershipId: integer("user_membership_id").notNull(),
    body: text("body").default("").notNull(),
    isInternal: boolean("is_internal").default(false).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ticket_drafts_ticket_id_org" }).onDelete("cascade"),
    uniqueIndex("uniq_support_ticket_drafts_ticket_membership").on(table.ticketId, table.userMembershipId),
    unique("uniq_support_ticket_drafts_org_id").on(table.orgId, table.id),
    index("idx_support_ticket_drafts_org_user_actor").on(table.orgId, table.userMembershipId),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_ticket_drafts_user_actor",
    }).onDelete("cascade"),
  ],
);
