import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { supportTickets } from "./tickets";
import { customFieldDefinitions } from "../custom-field-engine";

export const supportTicketCustomFieldValues = pgTable(
  "support_ticket_custom_field_values",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .references(() => supportTickets.id, { onDelete: "cascade" })
      .notNull(),
    fieldDefinitionId: integer("field_definition_id")
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    value: text("value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_custom_field_values_ticket_field").on(
      table.ticketId,
      table.fieldDefinitionId,
    ),
    index("idx_support_ticket_custom_field_values_org_ticket").on(
      table.orgId,
      table.ticketId,
    ),
    unique("uniq_stcfv_org_id").on(table.orgId, table.id),
  ],
);
