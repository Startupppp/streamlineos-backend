import { pgTable, pgEnum, serial, text, integer, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { supportTickets } from "../crm/billing";

export const supportExternalEntityTypeEnum = pgEnum("support_external_entity_type", [
  "project",
  "invoice",
  "calendar_event",
  "chat_channel",
]);

export const supportTicketExternalLinks = pgTable(
  "support_ticket_external_links",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    entityType: supportExternalEntityTypeEnum("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    label: text("label").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_external_links_ticket_entity").on(
      table.ticketId,
      table.entityType,
      table.entityId,
    ),
    index("idx_support_ticket_external_links_org_ticket").on(table.orgId, table.ticketId),
    unique("uniq_support_ticket_ext_links_org_id").on(table.orgId, table.id),
  ],
);
