import { pgTable, text, serial, timestamp, date, decimal, integer, boolean, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invAiFeedbackVerdictEnum, invAiInsightStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";
import { invPurchaseOrders, invVendors } from "./purchase-orders";

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

/**
 * F3 — the anomaly queue.
 *
 * The six detectors have always written here; what F3 adds is everything a
 * human needs in order to *review* a row rather than merely read it.
 *
 * `warehouse_id` is the load-bearing one. Without it the queue is org-wide, so
 * an operator assigned to one site is shown — and can acknowledge — signals
 * about sites they cannot open, which is the disclosure §4 forbids with no way
 * to filter it in SQL. It is nullable because some detectors are genuinely
 * organisation-aggregate (a demand series summed across every site does not
 * belong to one), and a NULL is read as exactly that: an org-wide figure, shown
 * only to a caller whose scope is org-wide.
 *
 * `window_days` and `evidence_hash` are what make a row auditable later.
 * The window is the observation period the detector actually used, stored
 * beside the finding rather than re-derived from today's constants — a
 * threshold changed next month must not silently rewrite what last month's
 * alert claimed. The hash fingerprints the material figures, so "is this still
 * true?" is answerable without re-running the detector.
 *
 * `acknowledged_by`/`acknowledged_at`/`resolution_note` are the review itself.
 * A status with no actor is a queue nobody is accountable for.
 */
export const invAiInsights = pgTable("inv_ai_insights", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  insightType: text("insight_type").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceRefs: jsonb("source_refs").$type<Record<string, unknown>>(),
  status: invAiInsightStatusEnum("status").default("NEW").notNull(),
  /**
   * Which site this finding is about. NULL means the figure aggregates the
   * whole organisation and is therefore org-wide information.
   */
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }),
  /** The observation window the detector used, in days, as it was when it ran. */
  windowDays: integer("window_days"),
  /** SHA-256 prefix over the material figures. Answers "is this still true?". */
  evidenceHash: text("evidence_hash"),
  acknowledgedBy: text("acknowledged_by").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at"),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_ai_insights_org_id").on(table.orgId, table.id),
  index("idx_inv_ai_insights_org_status").on(table.orgId, table.status),
  /**
   * The queue's own read: this org, the sites I can see, open first, newest
   * first. Leads with `org_id` because RLS adds `org_id = app.current_org_id()`
   * and an index that does not supply it can never serve an index-only scan.
   */
  index("idx_inv_ai_insights_org_wh_status")
    .on(table.orgId, table.warehouseId, table.status, table.createdAt),
]);

/**
 * F6 — a verdict on one AI answer, kept beside what produced it.
 *
 * The point of this table is not a satisfaction score. It is that when somebody
 * says an answer was wrong, the row records enough to *find the call again*:
 * the gateway correlation id, the prompt key and version, the contract version,
 * the model, the evidence hash the answer was built on, and what it cost. An
 * "AI is bad" ticket with none of those is unactionable; with them it is a
 * lookup.
 *
 * The evidence hash is why `STALE` is a distinct verdict rather than a flavour
 * of `WRONG`: a stale answer was correct when computed, and the hash is what
 * proves it — comparing the stored hash against the position now separates "the
 * engine was wrong" from "the world moved".
 *
 * Nothing here egresses. No prompt text, no answer text, no permission data —
 * only ids, versions and figures, plus a bounded note the reporter typed.
 * Append-only: a verdict is a historical act, and editing one rewrites what
 * somebody said about an answer they can no longer see.
 */
export const invAiFeedback = pgTable("inv_ai_feedback", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  /** Which AI surface was being judged. A closed set in `INV_AI_SURFACES`. */
  surface: text("surface").notNull(),
  verdict: invAiFeedbackVerdictEnum("verdict").notNull(),
  /** The gateway feature key the paid call was billed under. */
  feature: text("feature").notNull(),
  promptKey: text("prompt_key").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  contractVersion: integer("contract_version").notNull(),
  model: text("model").notNull(),
  /** The gateway's own id for the call. The join back into `ai_usage_logs`. */
  correlationId: text("correlation_id").notNull(),
  evidenceHash: text("evidence_hash"),
  totalTokens: integer("total_tokens").default(0).notNull(),
  credits: integer("credits").default(0).notNull(),
  /** Provider cost in millionths of a dollar — an integer, never a float. */
  costMicroUsd: integer("cost_micro_usd").default(0).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_ai_feedback_org_id").on(table.orgId, table.id),
  /**
   * One verdict per person per answer. A second submission updates the first
   * rather than stacking, so a user who changes their mind does not appear as
   * two reporters.
   */
  uniqueIndex("uniq_inv_ai_feedback_org_user_call")
    .on(table.orgId, table.userId, table.correlationId),
  index("idx_inv_ai_feedback_org_verdict").on(table.orgId, table.verdict, table.createdAt),
  index("idx_inv_ai_feedback_org_surface").on(table.orgId, table.surface, table.createdAt),
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

/**
 * C2 — a person overruling the engine, on the record.
 *
 * The engine owns the quantity. That is the whole point of C2, and it is only
 * true if the escape hatch is a *different act* rather than the same act with a
 * different number in it. A buyer who knows something the ledger does not — a
 * promotion next month, a supplier closing for a fortnight — must be able to
 * order more than the arithmetic asks for. What must not happen is that number
 * arriving as an ordinary quantity field and becoming indistinguishable from
 * the engine's own answer the moment the purchase order is written.
 *
 * So an override is its own row: which stored proposal it overruled, what the
 * engine would have ordered, what the person asked for, what was actually
 * ordered after the supplier's minimum and pack size were applied to *their*
 * number too, why, who, and which purchase order it became. Every one of those
 * is unanswerable from `inv_po_lines`, which records only the number that won.
 *
 * The supplier's order policy is applied to an override as well, which is why
 * `requested_qty` and `ordered_qty` are separate columns: a person asking for 30
 * against a case of 12 buys 36, and the difference is the policy's doing rather
 * than theirs.
 *
 * Append-only, like the forecasts it annotates — an override is a historical
 * act, and editing one would rewrite the reason a purchase order exists.
 */
export const invProposalOverrides = pgTable("inv_proposal_overrides", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /** The stored proposal (`inv_demand_forecasts` row) that was overruled. */
  forecastId: integer("forecast_id").references(() => invDemandForecasts.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  /** NULL means the proposal covered the whole organisation. */
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }),
  /** What the server would have ordered on its own, after the order policy. */
  engineQty: decimal("engine_qty", { precision: 18, scale: 4 }).notNull(),
  /** What the person asked for, as they stated it. */
  requestedQty: decimal("requested_qty", { precision: 18, scale: 4 }).notNull(),
  /** What went on the line: the person's number, through the supplier's policy. */
  orderedQty: decimal("ordered_qty", { precision: 18, scale: 4 }).notNull(),
  reason: text("reason").notNull(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "cascade" }).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_proposal_overrides_org_id").on(table.orgId, table.id),
  index("idx_inv_proposal_overrides_org_forecast").on(table.orgId, table.forecastId, table.createdAt),
  index("idx_inv_proposal_overrides_org_po").on(table.orgId, table.poId),
]);

export const invProposalOverridesRelations = relations(invProposalOverrides, ({ one }) => ({
  organization: one(organizations, { fields: [invProposalOverrides.orgId], references: [organizations.id] }),
  forecast: one(invDemandForecasts, { fields: [invProposalOverrides.forecastId], references: [invDemandForecasts.id] }),
  productVariant: one(invProductVariants, { fields: [invProposalOverrides.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invProposalOverrides.warehouseId], references: [invWarehouses.id] }),
}));

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
  warehouse: one(invWarehouses, { fields: [invAiInsights.warehouseId], references: [invWarehouses.id] }),
}));

export const invAiFeedbackRelations = relations(invAiFeedback, ({ one }) => ({
  organization: one(organizations, { fields: [invAiFeedback.orgId], references: [organizations.id] }),
}));
