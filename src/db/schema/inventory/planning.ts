import { pgTable, text, serial, timestamp, date, decimal, integer, boolean, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invAiInsightStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";
import { invVendors } from "./purchase-orders";

export const invReorderRules = pgTable("inv_reorder_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  minQty: decimal("min_qty", { precision: 18, scale: 4 }).notNull(),
  maxQty: decimal("max_qty", { precision: 18, scale: 4 }),
  reorderQty: decimal("reorder_qty", { precision: 18, scale: 4 }),
  vendorId: integer("vendor_id").references(() => invVendors.id, { onDelete: "set null" }),
  leadTimeDays: integer("lead_time_days"),
  safetyStock: decimal("safety_stock", { precision: 18, scale: 4 }).default("0"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_reorder_org_variant_wh").on(table.orgId, table.productVariantId, table.warehouseId),
  unique("uniq_inv_reorder_rules_org_id").on(table.orgId, table.id),
  index("idx_inv_reorder_org").on(table.orgId),
  index("idx_inv_reorder_variant").on(table.productVariantId),
]);

export const invAiInsights = pgTable("inv_ai_insights", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  insightType: text("insight_type").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceRefs: jsonb("source_refs").$type<Record<string, unknown>>(),
  status: invAiInsightStatusEnum("status").default("NEW").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_ai_insights_org_id").on(table.orgId, table.id),
  index("idx_inv_ai_insights_org_status").on(table.orgId, table.status),
]);

/**
 * C1 — a forecast that was actually made, kept.
 *
 * The engine computed on every read and stored nothing, which has two costs.
 * Accuracy could never be measured: comparing "what we forecast in March"
 * against "what April did" needs March's forecast to still exist, and
 * recomputing it from today's ledger answers a different question. And a
 * proposal a buyer acted on could not be reconstructed — the purchase order
 * said what was bought, nothing said why.
 *
 * **This table is append-only history, not a latest-value row**, for exactly
 * those two reasons. An `UPDATE`-in-place design destroys the earlier forecast,
 * which is the only evidence of what the engine claimed before the demand moved;
 * "latest" is a cheap query over history (`ORDER BY generated_at DESC LIMIT 1`)
 * while history is not recoverable from latest.
 *
 * It does not grow per read, because a version is keyed on a fingerprint of its
 * inputs: the same variant, warehouse, window, service level and demand series
 * produce the same row rather than a near-duplicate. A new row appears when the
 * inputs actually changed — which is precisely when there is something new to
 * remember.
 *
 * Not partitioned (§3): one row per (variant, warehouse, changed input state) is
 * not a high-volume append-only stream, and partitioning a table that is not
 * demonstrably large costs a compound primary key for nothing.
 *
 * Every quantity is `numeric(18,4)` and is written from an exact decimal string.
 * The statistics — z, MAE, RMSE, bias, MASE, ADI, CV² — are estimates and are
 * stored at the precision they were computed to; see `forecast/exact.ts` for
 * where that line is drawn and why.
 */
export const invDemandForecasts = pgTable("inv_demand_forecasts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  /** NULL means the whole organisation. A number means this one warehouse. */
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }),

  /** Coverage: which periods the forecast was fitted over, and how far ahead it speaks. */
  historyWeeks: integer("history_weeks").notNull(),
  horizonWeeks: integer("horizon_weeks").notNull(),
  periods: integer("periods").notNull(),
  coverageFrom: date("coverage_from").notNull(),
  coverageTo: date("coverage_to").notNull(),

  /** The champion baseline, or NULL when no method could be justified. */
  method: text("method"),
  demandCategory: text("demand_category").notNull(),
  adi: decimal("adi", { precision: 18, scale: 4 }).notNull(),
  cv2: decimal("cv2", { precision: 18, scale: 4 }).notNull(),
  seasonLength: integer("season_length"),

  /** Backtest metrics for the champion. NULL when there was no champion to score. */
  mae: decimal("mae", { precision: 18, scale: 4 }),
  rmse: decimal("rmse", { precision: 18, scale: 4 }),
  bias: decimal("bias", { precision: 18, scale: 4 }),
  mase: decimal("mase", { precision: 18, scale: 4 }),

  serviceLevel: decimal("service_level", { precision: 6, scale: 4 }).notNull(),
  /**
   * Whether a normal-model safety stock describes this demand at all. A refusal
   * is a stored state rather than an absent row, and the CHECK in the migration
   * makes a refusal without a reason impossible.
   */
  applicable: boolean("applicable").notNull(),
  refusalReason: text("refusal_reason"),
  safetyStock: decimal("safety_stock", { precision: 18, scale: 4 }),
  reorderPoint: decimal("reorder_point", { precision: 18, scale: 4 }),
  leadTimeDemand: decimal("lead_time_demand", { precision: 18, scale: 4 }),
  z: decimal("z", { precision: 12, scale: 6 }),

  demandMean: decimal("demand_mean", { precision: 18, scale: 4 }).notNull(),
  demandStdDev: decimal("demand_std_dev", { precision: 18, scale: 4 }).notNull(),
  leadTimeWeeks: decimal("lead_time_weeks", { precision: 18, scale: 4 }).notNull(),
  leadTimeStdDevWeeks: decimal("lead_time_std_dev_weeks", { precision: 18, scale: 4 }).notNull(),
  leadTimeObservations: integer("lead_time_observations").notNull(),

  /**
   * How many periods closed with nothing on hand. Demand in those periods is a
   * lower bound, so a forecast fitted across them understates reality — which is
   * a property of the *forecast*, not of the reader, and therefore is stored
   * with it rather than recomputed by whoever displays it.
   */
  censoredPeriods: integer("censored_periods").default(0).notNull(),
  stockoutCensored: boolean("stockout_censored").default(false).notNull(),

  /**
   * The assumptions the version was computed under, as a document: the window,
   * the fallback lead time, the method restriction, the caveats. A document, not
   * a list of entities — §3 bans JSONB arrays because they cannot be indexed,
   * paginated or atomically updated, and none of those are things anybody asks
   * of an assumption set.
   */
  assumptions: jsonb("assumptions").$type<Record<string, unknown>>().notNull(),
  /**
   * SHA-256 over the exact inputs. Two calls over the same fixture land on the
   * same row instead of appending a near-duplicate, which is what makes this a
   * history of forecasts rather than a log of reads.
   */
  inputFingerprint: text("input_fingerprint").notNull(),

  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  generatedBy: text("generated_by").references(() => users.id).notNull(),
}, (table) => [
  unique("uniq_inv_demand_forecasts_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_inv_demand_forecasts_fingerprint")
    .on(table.orgId, table.productVariantId, table.warehouseId, table.inputFingerprint),
  index("idx_inv_demand_forecasts_org_variant")
    .on(table.orgId, table.productVariantId, table.warehouseId, table.generatedAt),
]);

export const invDemandForecastsRelations = relations(invDemandForecasts, ({ one }) => ({
  organization: one(organizations, { fields: [invDemandForecasts.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invDemandForecasts.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invDemandForecasts.warehouseId], references: [invWarehouses.id] }),
}));

export const invReorderRulesRelations = relations(invReorderRules, ({ one }) => ({
  organization: one(organizations, { fields: [invReorderRules.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invReorderRules.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invReorderRules.warehouseId], references: [invWarehouses.id] }),
}));

export const invAiInsightsRelations = relations(invAiInsights, ({ one }) => ({
  organization: one(organizations, { fields: [invAiInsights.orgId], references: [organizations.id] }),
}));
