import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { supportTickets } from "./tickets";

export const CUSTOM_FIELD_TYPES = ["text", "number", "select", "checkbox", "date"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const supportCustomFields = pgTable(
  "support_custom_fields",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").default(false).notNull(),
    category: text("category"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_custom_fields_org_key").on(table.orgId, table.key),
    index("idx_support_custom_fields_org_active").on(table.orgId, table.isActive),
    unique("uniq_support_custom_fields_org_id").on(table.orgId, table.id),
  ],
);

export const supportTicketCustomFieldValues = pgTable(
  "support_ticket_custom_field_values",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    fieldId: integer("field_id").references(() => supportCustomFields.id, { onDelete: "cascade" }).notNull(),
    value: text("value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_custom_field_values_ticket_field").on(table.ticketId, table.fieldId),
    index("idx_support_ticket_custom_field_values_org_ticket").on(table.orgId, table.ticketId),
    unique("uniq_support_tcfv_org_id").on(table.orgId, table.id),
  ],
);
