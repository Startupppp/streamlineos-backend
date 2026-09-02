import {
  pgTable,
  bigint,
  text,
  integer,
  decimal,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

/**
 * Integration-owned mapping between a CRM Offer (crm_products) and the Inventory SKU
 * (inv_product_variants) that fulfills it (wave-6 §6, T6.4). This bridge is owned by
 * neither CRM nor Inventory: it deliberately carries NO foreign key into either module
 * so the two schemas stay decoupled — only the tenant-scoped org_id FK is enforced in
 * the DB, and crm_offer_org_id / inv_sku_org_id are stored explicitly so a mapping can
 * be asserted tenant-safe without joining both modules. Supports bundles / many-to-many
 * (one offer → many SKUs, one SKU → many offers). Lifecycle is modelled by `status` +
 * effective dates rather than a soft-delete flag; removing a mapping is a hard delete.
 */
export const offerFulfillmentComponents = pgTable(
  "offer_fulfillment_components",
  {
    offerFulfillmentComponentId: bigint("offer_fulfillment_component_id", {
      mode: "number",
    })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    crmOfferId: integer("crm_offer_id").notNull(),
    crmOfferOrgId: text("crm_offer_org_id").notNull(),

    invSkuId: integer("inv_sku_id").notNull(),
    invSkuOrgId: text("inv_sku_org_id").notNull(),

    quantityPerUnit: decimal("quantity_per_unit", { precision: 10, scale: 4 })
      .default("1")
      .notNull(),
    uom: text("uom"),
    status: text("status").$type<"active" | "inactive">().default("active").notNull(),
    effectiveFrom: timestamp("effective_from"),
    effectiveTo: timestamp("effective_to"),
    notes: text("notes"),

    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_offer_fulfillment_components_org_offer_sku").on(
      table.orgId,
      table.crmOfferId,
      table.invSkuId,
    ),
    index("idx_offer_fulfillment_components_sku").on(table.orgId, table.invSkuId),
  ],
);
