import { foreignKey, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { supportTickets } from "./tickets";

export const supportCsatRequests = pgTable(
  "support_csat_requests",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").notNull(),
    token: text("token").notNull(),
    score: integer("score"),
    comment: text("comment"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_csat_requests_ticket_id_org" }).onDelete("cascade"),
    uniqueIndex("uniq_support_csat_requests_token").on(table.token),
    uniqueIndex("uniq_support_csat_requests_ticket").on(table.ticketId),
    unique("uniq_support_csat_requests_org_id").on(table.orgId, table.id),
  ],
);

export const supportCsatRequestsRelations = relations(supportCsatRequests, ({ one }) => ({
  organization: one(organizations, { fields: [supportCsatRequests.orgId], references: [organizations.id] }),
  ticket: one(supportTickets, { fields: [supportCsatRequests.ticketId], references: [supportTickets.id] }),
}));
