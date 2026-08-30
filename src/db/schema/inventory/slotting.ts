import { pgTable, text, serial, timestamp, integer, boolean, decimal, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  invVelocityClassEnum,
  invSlottingMatchEnum,
  invSlottingRecommendationStatusEnum,
  invLocationTypeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants, invCategories } from "./core";
import { invLocations, invWarehouses } from "./warehouses";

/**
 * NEO-6 - where a SKU is supposed to live.
 *
 * Putaway used to rank bins by remaining capacity alone, which fills a building
 * evenly and slots it badly: the fastest-moving SKU in the warehouse ends up
 * wherever there happened to be room on the day it arrived, and every pick after
 * that walks to it. Slotting is the rule that says a fast mover belongs in the
 * gold zone - the bins nearest despatch, at waist height - and a dead SKU belongs
 * upstairs.
 *
 * A rule matches on one of three things and targets a **zone**, not a bin.
 * Naming a bin would make the rule wrong the moment that bin is full, and the
 * point of a rule is to survive the day-to-day. `PutawayService` reads the rules,
 * ranks matching locations first, and still refuses a bin the quantity does not
 * fit in - a suggestion that cannot be accepted is worse than none.
 *
 * `priority` breaks ties, lowest first. Two rules that both match a SKU is
 * ordinary - "class A" and "this category" - and the alternative to an explicit
 * order is whichever the planner happened to read first.
 */
export const invSlottingRules = pgTable("inv_slotting_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  matchType: invSlottingMatchEnum("match_type").notNull(),
  /** Set when `match_type = VELOCITY_CLASS`. */
  velocityClass: invVelocityClassEnum("velocity_class"),
  /** Set when `match_type = CATEGORY`. */
  categoryId: integer("category_id").references(() => invCategories.id, { onDelete: "cascade" }),
  /** Set when `match_type = PRODUCT_VARIANT`. */
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }),
  /**
   * The zone this rule sends matching stock to. A location of type ZONE, whose
   * descendants are the bins that actually take the goods.
   */
  targetZoneLocationId: integer("target_zone_location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  /** Narrows the target further, when a zone holds more than one kind of bin. */
  targetLocationType: invLocationTypeEnum("target_location_type"),
  priority: integer("priority").default(100).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_slotting_rules_org_name").on(table.orgId, table.warehouseId, table.name),
  unique("uniq_inv_slotting_rules_org_id").on(table.orgId, table.id),
  index("idx_inv_slotting_rules_org_warehouse_active")
    .on(table.orgId, table.warehouseId, table.priority)
    .where(sql`is_active = true`),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_slotting_rules_warehouse_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.targetZoneLocationId],
    foreignColumns: [invLocations.orgId, invLocations.id],
    name: "fk_inv_slotting_rules_zone_org",
  }).onDelete("cascade"),
  // The discriminator and its payload move together, or a rule reads as
  // configured and matches nothing.
  check(
    "chk_inv_slotting_rules_match_payload",
    sql`(${table.matchType} = 'VELOCITY_CLASS' AND ${table.velocityClass} IS NOT NULL AND ${table.categoryId} IS NULL AND ${table.productVariantId} IS NULL)
     OR (${table.matchType} = 'CATEGORY' AND ${table.categoryId} IS NOT NULL AND ${table.velocityClass} IS NULL AND ${table.productVariantId} IS NULL)
     OR (${table.matchType} = 'PRODUCT_VARIANT' AND ${table.productVariantId} IS NOT NULL AND ${table.velocityClass} IS NULL AND ${table.categoryId} IS NULL)`,
  ),
]);

/**
 * NEO-6 - a SKU's velocity class, recomputed on a window.
 *
 * Stored rather than derived at read time because putaway asks for it on every
 * suggestion and the derivation is a scan of the ledger. `computedAt` and
 * `windowDays` are on the row so a stale class is visible as stale rather than
 * simply wrong, and `pickCount` is kept beside the class so a planner can see
 * what the classification was made of.
 */
export const invVelocityClasses = pgTable("inv_velocity_classes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  velocityClass: invVelocityClassEnum("velocity_class").notNull(),
  /** Movement lines in the window - the number of *visits*, not units. */
  pickCount: integer("pick_count").default(0).notNull(),
  /** Units issued in the window. */
  issuedQty: decimal("issued_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  windowDays: integer("window_days").notNull(),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_velocity_org_warehouse_variant")
    .on(table.orgId, table.warehouseId, table.productVariantId),
  unique("uniq_inv_velocity_classes_org_id").on(table.orgId, table.id),
  index("idx_inv_velocity_org_warehouse_class").on(table.orgId, table.warehouseId, table.velocityClass),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_velocity_variant_org",
  }).onDelete("cascade"),
]);

/**
 * NEO-6 - "this pallet is in the wrong place", written down.
 *
 * The re-slot job is **read-only**. It compares where stock is standing against
 * where the rules say it belongs and records the difference; it moves nothing.
 * That is the whole design: a warehouse that rearranges itself overnight is one
 * where a picker's memory of yesterday is a liability, and the supervisor who
 * has to answer for the labour is the person who should decide whether it is
 * worth it.
 *
 * Approving one creates the work through the ordinary command - a transfer - so
 * the move is a ledger fact like any other and not a special case.
 */
export const invSlottingRecommendations = pgTable("inv_slotting_recommendations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  fromLocationId: integer("from_location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  /** The zone the rule points at. The bin is chosen when the move is approved. */
  toZoneLocationId: integer("to_zone_location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  ruleId: integer("rule_id").references(() => invSlottingRules.id, { onDelete: "set null" }),
  /** Why, in a sentence a supervisor can act on. */
  reason: text("reason").notNull(),
  status: invSlottingRecommendationStatusEnum("status").default("PENDING").notNull(),
  /** The transfer raised when this was approved. */
  transferId: integer("transfer_id"),
  decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_slotting_recommendations_org_id").on(table.orgId, table.id),
  // One live recommendation per grain. A nightly job that re-proposed the same
  // move every night would bury the ones somebody has not seen yet.
  uniqueIndex("uniq_inv_slotting_recommendation_open")
    .on(table.orgId, table.productVariantId, table.fromLocationId)
    .where(sql`status = 'PENDING'`),
  index("idx_inv_slotting_recommendations_org_status")
    .on(table.orgId, table.warehouseId, table.status, table.createdAt),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_slotting_recommendation_variant_org",
  }).onDelete("cascade"),
  check("chk_inv_slotting_recommendations_qty_positive", sql`${table.quantity} > 0`),
]);

export const invSlottingRulesRelations = relations(invSlottingRules, ({ one }) => ({
  organization: one(organizations, { fields: [invSlottingRules.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invSlottingRules.warehouseId], references: [invWarehouses.id] }),
  targetZone: one(invLocations, { fields: [invSlottingRules.targetZoneLocationId], references: [invLocations.id] }),
}));

export const invVelocityClassesRelations = relations(invVelocityClasses, ({ one }) => ({
  productVariant: one(invProductVariants, {
    fields: [invVelocityClasses.productVariantId],
    references: [invProductVariants.id],
  }),
}));

export const invSlottingRecommendationsRelations = relations(invSlottingRecommendations, ({ one }) => ({
  rule: one(invSlottingRules, { fields: [invSlottingRecommendations.ruleId], references: [invSlottingRules.id] }),
  productVariant: one(invProductVariants, {
    fields: [invSlottingRecommendations.productVariantId],
    references: [invProductVariants.id],
  }),
}));
