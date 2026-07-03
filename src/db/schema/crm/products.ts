import { pgTable, text, serial, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export const crmProducts = pgTable("crm_products", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  sku: text("sku"),
  category: text("category"),
  unitPrice: integer("unit_price").notNull(),
  currency: text("currency").default("INR").notNull(),
  taxRate: integer("tax_rate").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_crm_products_org").on(table.orgId, table.isActive, table.createdAt),
  index("idx_crm_products_deleted").on(table.deletedAt),
]);

export const crmProductsRelations = relations(crmProducts, ({ one }) => ({
  organization: one(organizations, { fields: [crmProducts.orgId], references: [organizations.id] }),
}));
