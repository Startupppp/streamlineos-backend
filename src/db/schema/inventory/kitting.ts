import { pgTable, text, serial, timestamp, integer, decimal, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";

/**
 * NEO-9 - what a kit is made of.
 *
 * A kit is a SKU a customer can order that does not exist until somebody builds
 * it: a gift set, a starter pack, a bundle. Before this, the only way to sell one
 * was to hold it as ordinary stock and let the shelf count drift from the
 * components sitting beside it.
 *
 * **This is a bill of materials for stock, not for manufacturing.** There is no
 * routing, no operation, no work centre and no labour: assembling consumes the
 * components and creates the kit, in one command, at one moment. A business that
 * needs a shop floor needs a manufacturing module, and pretending this is one
 * would be the worst kind of half-feature.
 *
 * `quantityPer` is decimal because a kit can contain 0.250 kg of something.
 * A component may appear once per kit - the same component twice is two rows
 * that have to be added up by every reader, and the unique index says so.
 */
export const invKitComponents = pgTable("inv_kit_components", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  kitVariantId: integer("kit_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  componentVariantId: integer("component_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantityPer: decimal("quantity_per", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_kit_components_kit_component")
    .on(table.orgId, table.kitVariantId, table.componentVariantId),
  unique("uniq_inv_kit_components_org_id").on(table.orgId, table.id),
  index("idx_inv_kit_components_org_kit").on(table.orgId, table.kitVariantId, table.lineOrder),
  index("idx_inv_kit_components_org_component").on(table.orgId, table.componentVariantId),
  foreignKey({
    columns: [table.orgId, table.kitVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_kit_components_kit_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.componentVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_kit_components_component_org",
  }),
  check("chk_inv_kit_components_qty_positive", sql`${table.quantityPer} > 0`),
  // A kit that contains itself is an infinite build. One hop is what a constraint
  // can see; `KitService` walks the whole chain before writing a row.
  check("chk_inv_kit_components_not_self", sql`${table.kitVariantId} <> ${table.componentVariantId}`),
]);

export const invKitComponentsRelations = relations(invKitComponents, ({ one }) => ({
  organization: one(organizations, { fields: [invKitComponents.orgId], references: [organizations.id] }),
  kitVariant: one(invProductVariants, {
    fields: [invKitComponents.kitVariantId],
    references: [invProductVariants.id],
    relationName: "kit",
  }),
  componentVariant: one(invProductVariants, {
    fields: [invKitComponents.componentVariantId],
    references: [invProductVariants.id],
    relationName: "kit_component",
  }),
}));
