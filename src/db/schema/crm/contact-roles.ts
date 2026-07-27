import { pgTable, text, boolean, timestamp, integer, index, uniqueIndex, uuid, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { contacts } from "./contacts";

export const crmContactRoles = pgTable("crm_contact_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  roleKey: text("role_key").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_contact_roles_org").on(table.orgId),
  index("idx_crm_contact_roles_contact").on(table.contactId),
  index("idx_crm_contact_roles_entity").on(table.orgId, table.entityType, table.entityId),
  uniqueIndex("uniq_crm_contact_roles_combo").on(
    table.orgId,
    table.contactId,
    table.entityType,
    table.entityId,
    table.roleKey,
  ),
  unique("uniq_crm_contact_roles_org_id").on(table.orgId, table.id),
]);

export const crmContactRolesRelations = relations(crmContactRoles, ({ one }) => ({
  contact: one(contacts, { fields: [crmContactRoles.contactId], references: [contacts.id] }),
  organization: one(organizations, { fields: [crmContactRoles.orgId], references: [organizations.id] }),
}));
