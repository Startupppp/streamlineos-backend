import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { supportTickets } from "./tickets";

export const supportCsatRequests = pgTable(
  "support_csat_requests",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    token: text("token").notNull(),
    score: integer("score"),
    comment: text("comment"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_csat_requests_token").on(table.token),
    uniqueIndex("uniq_support_csat_requests_ticket").on(table.ticketId),
    index("idx_support_csat_requests_org").on(table.orgId),
    unique("uniq_support_csat_requests_org_id").on(table.orgId, table.id),
  ],
);

export const supportCsatRequestsRelations = relations(supportCsatRequests, ({ one }) => ({
  organization: one(organizations, { fields: [supportCsatRequests.orgId], references: [organizations.id] }),
  ticket: one(supportTickets, { fields: [supportCsatRequests.ticketId], references: [supportTickets.id] }),
}));
