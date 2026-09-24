import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { supportTickets } from "./tickets";

export const supportActivityActionEnum = pgEnum("support_activity_action", [
  "created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "replied",
  "internal_note",
  "resolved",
  "reopened",
  "merged",
  "linked",
  "split",
  "snoozed",
  "unsnoozed",
]);

export const supportTicketActivity = pgTable(
  "support_ticket_activity",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    supportTicketId: integer("support_ticket_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: supportActivityActionEnum("action").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.supportTicketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ticket_activity_support_ticket_id_org" }).onDelete("cascade"),
    index("idx_support_ticket_activity_ticket").on(table.supportTicketId),
    unique("uniq_support_ticket_activity_org_id").on(table.orgId, table.id),
  ],
);

export const supportTicketActivityRelations = relations(supportTicketActivity, ({ one }) => ({
  organization: one(organizations, { fields: [supportTicketActivity.orgId], references: [organizations.id] }),
  ticket: one(supportTickets, { fields: [supportTicketActivity.supportTicketId], references: [supportTickets.id] }),
  user: one(users, { fields: [supportTicketActivity.userId], references: [users.id] }),
}));
