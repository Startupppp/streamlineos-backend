import { pgTable, text, serial, timestamp, decimal, integer, boolean, jsonb, check, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  invQualityInspectionStatusEnum, invQualityHoldStatusEnum,
  invQualityDispositionEnum, invRecallStatusEnum,
  invInspectionSamplingMethodEnum, invInspectionPlanVersionStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants, invProducts, invCategories } from "./core";
import { invLocations } from "./warehouses";
import { invLots, invSerialNumbers } from "./traceability";

/**
 * D3 — which arrivals have to be looked at, and how hard.
 *
 * The plan is split from its versions on purpose. An inspection records the
 * *version* that governed it, so the rule a completed result was judged against
 * stays readable forever; the plan is the stable identity that a SKU is matched
 * against, so changing the sampling rule does not orphan the match.
 *
 * Scope is an exclusive arc rather than an `entity_type`/`entity_id` pair
 * (backend §3): at most one of variant, product and category may be set, and all
 * three null is the organisation-wide plan. Specificity is derived from which
 * one is set — variant beats product beats category beats everything — so there
 * is no second column that can disagree with the foreign keys.
 */
export const invInspectionPlans = pgTable("inv_inspection_plans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => invProducts.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => invCategories.id, { onDelete: "cascade" }),
  appliesOnReceipt: boolean("applies_on_receipt").default(true).notNull(),
  appliesOnReturn: boolean("applies_on_return").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_inv_inspection_plans_org_code_live")
    .on(table.orgId, table.code)
    .where(sql`${table.deletedAt} IS NULL`),
  unique("uniq_inv_inspection_plans_org_id").on(table.orgId, table.id),
  index("idx_inv_inspection_plans_org_live")
    .on(table.orgId, table.isActive)
    .where(sql`${table.deletedAt} IS NULL`),
  index("idx_inv_inspection_plans_variant").on(table.orgId, table.productVariantId),
  index("idx_inv_inspection_plans_product").on(table.orgId, table.productId),
  index("idx_inv_inspection_plans_category").on(table.orgId, table.categoryId),
  check(
    "chk_inv_inspection_plans_scope",
    sql`num_nonnulls(product_variant_id, product_id, category_id) <= 1`,
  ),
  check(
    "chk_inv_inspection_plans_trigger",
    sql`applies_on_receipt OR applies_on_return`,
  ),
]);

export const invInspectionPlanVersions = pgTable("inv_inspection_plan_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  planId: integer("plan_id").references(() => invInspectionPlans.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  samplingMethod: invInspectionSamplingMethodEnum("sampling_method").default("ALL").notNull(),
  /** Percent for PERCENTAGE, an absolute quantity for FIXED_QUANTITY, null for ALL. */
  sampleValue: decimal("sample_value", { precision: 18, scale: 4 }),
  instructions: text("instructions"),
  status: invInspectionPlanVersionStatusEnum("status").default("DRAFT").notNull(),
  activatedAt: timestamp("activated_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_inspection_plan_versions_number").on(table.orgId, table.planId, table.version),
  // One live rule per plan. Two ACTIVE versions is a plan that answers a
  // receipt differently depending on which row the query happened to read.
  uniqueIndex("uniq_inv_inspection_plan_versions_active")
    .on(table.orgId, table.planId)
    .where(sql`${table.status} = 'ACTIVE'`),
  unique("uniq_inv_inspection_plan_versions_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.planId],
    foreignColumns: [invInspectionPlans.orgId, invInspectionPlans.id],
    name: "fk_inv_inspection_plan_versions_plan_id_org",
  }).onDelete("cascade"),
  index("idx_inv_inspection_plan_versions_plan").on(table.planId),
  check(
    "chk_inv_inspection_plan_versions_sample",
    sql`(sampling_method = 'ALL' AND sample_value IS NULL)
        OR (sampling_method = 'PERCENTAGE' AND sample_value > 0 AND sample_value <= 100)
        OR (sampling_method = 'FIXED_QUANTITY' AND sample_value > 0)`,
  ),
  check("chk_inv_inspection_plan_versions_version", sql`version > 0`),
]);

export const invQualityInspections = pgTable("inv_quality_inspections", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  inspectionNumber: text("inspection_number").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  status: invQualityInspectionStatusEnum("status").default("PENDING").notNull(),
  inspectorUserId: text("inspector_user_id").references(() => users.id),
  inspectorMembershipId: integer("inspector_membership_id"),
  notes: text("notes"),
  completedAt: timestamp("completed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  cancelledAt: timestamp("cancelled_at"),
  /**
   * D3. A completed result is evidence and is never edited. Getting it wrong is
   * corrected the way a ledger is: a new inspection that names the one it
   * supersedes, so both the mistake and the correction stay readable.
   */
  correctsInspectionId: integer("corrects_inspection_id"),
  correctionReason: text("correction_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_qi_org_number").on(table.orgId, table.inspectionNumber),
  unique("uniq_inv_quality_inspections_org_id").on(table.orgId, table.id),
  index("idx_inv_qi_org_status").on(table.orgId, table.status),
  index("idx_inv_qi_source").on(table.orgId, table.sourceType, table.sourceId),
  foreignKey({
    columns: [table.correctsInspectionId],
    foreignColumns: [table.id],
    name: "fk_inv_quality_inspections_corrects",
  }).onDelete("set null"),
  // One correction per mistake. A second one is a correction of the correction
  // and must name it, or the chain stops being a chain.
  uniqueIndex("uniq_inv_qi_corrects")
    .on(table.orgId, table.correctsInspectionId)
    .where(sql`${table.correctsInspectionId} IS NOT NULL`),
  check(
    "chk_inv_quality_inspections_correction_reason",
    sql`corrects_inspection_id IS NULL OR correction_reason IS NOT NULL`,
  ),
]);

export const invQualityInspectionLines = pgTable("inv_quality_inspection_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  inspectionId: integer("inspection_id").references(() => invQualityInspections.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  /**
   * Where the units this line covers are standing. `QualityHoldsService.release`
   * learned the same lesson: a bucket movement has to be posted at the location
   * it was raised at, and a lookup by variant alone picks an arbitrary row the
   * moment one SKU sits in two bins.
   */
  locationId: integer("location_id").references(() => invLocations.id),
  /**
   * D3. What this inspection is itself holding in `quality_hold_qty` right now —
   * the exact figure `pass` and `dispose` release, rather than "the level has
   * some hold on it, release the line quantity". That guess released against
   * holds another document owned, leaving those unreleasable.
   */
  heldQuantity: decimal("held_quantity", { precision: 18, scale: 4 }).default("0").notNull(),
  /** How many units the plan requires be physically checked. */
  sampleQuantity: decimal("sample_quantity", { precision: 18, scale: 4 }),
  planVersionId: integer("plan_version_id").references(() => invInspectionPlanVersions.id, { onDelete: "set null" }),
  result: text("result"),
  notes: text("notes"),
  disposition: invQualityDispositionEnum("disposition"),
}, (table) => [
  unique("uniq_inv_quality_inspection_lines_org_id").on(table.orgId, table.id),
  check(
    "chk_inv_quality_inspection_lines_held",
    sql`held_quantity >= 0 AND held_quantity <= quantity`,
  ),
  foreignKey({
    columns: [table.orgId, table.inspectionId],
    foreignColumns: [invQualityInspections.orgId, invQualityInspections.id],
    name: "fk_inv_quality_inspection_lines_inspection_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_quality_inspection_lines_product_variant_id_org",
  }),
  index("idx_inv_qi_lines_insp").on(table.inspectionId),
  index("idx_inv_quality_inspection_lines_variant").on(table.productVariantId),
]);

export const invQualityHolds = pgTable("inv_quality_holds", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  reason: text("reason").notNull(),
  status: invQualityHoldStatusEnum("status").default("ACTIVE").notNull(),
  releasedBy: text("released_by").references(() => users.id),
  releasedByMembershipId: integer("released_by_membership_id"),
  releasedAt: timestamp("released_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_quality_holds_org_id").on(table.orgId, table.id),
  index("idx_inv_qh_org_status").on(table.orgId, table.status),
  index("idx_inv_qh_variant").on(table.orgId, table.productVariantId),
]);

export const invRecallEvents = pgTable("inv_recall_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recallNumber: text("recall_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: invRecallStatusEnum("status").default("OPEN").notNull(),
  /**
   * D4. The content hash of the impact picture this recall was executed
   * against, and that picture itself.
   *
   * A recall is a regulated act whose defensibility rests on what was known at
   * the time — "we recalled 14 lots" is not evidence, "these lots, this stock,
   * these 31 customers, hashed" is. Null for a recall raised from an explicit
   * line list, which asserts nothing about a wider picture.
   */
  evidenceVersion: text("evidence_version"),
  evidenceSnapshot: jsonb("evidence_snapshot").$type<Record<string, unknown>>(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_recall_org_number").on(table.orgId, table.recallNumber),
  unique("uniq_inv_recall_events_org_id").on(table.orgId, table.id),
  index("idx_inv_recall_org_status").on(table.orgId, table.status),
]);

export const invRecallLines = pgTable("inv_recall_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recallId: integer("recall_id").references(() => invRecallEvents.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  status: text("status").default("OPEN").notNull(),
}, (table) => [
  unique("uniq_inv_recall_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.recallId],
    foreignColumns: [invRecallEvents.orgId, invRecallEvents.id],
    name: "fk_inv_recall_lines_recall_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_recall_lines_product_variant_id_org",
  }),
  index("idx_inv_recall_lines_recall").on(table.recallId),
  index("idx_inv_recall_lines_variant").on(table.productVariantId),
]);

export const invQualityInspectionsRelations = relations(invQualityInspections, ({ one, many }) => ({
  organization: one(organizations, { fields: [invQualityInspections.orgId], references: [organizations.id] }),
  inspector: one(users, { fields: [invQualityInspections.inspectorUserId], references: [users.id], relationName: "qiInspector" }),
  creator: one(users, { fields: [invQualityInspections.createdBy], references: [users.id], relationName: "qiCreator" }),
  lines: many(invQualityInspectionLines),
}));

export const invQualityInspectionLinesRelations = relations(invQualityInspectionLines, ({ one }) => ({
  inspection: one(invQualityInspections, { fields: [invQualityInspectionLines.inspectionId], references: [invQualityInspections.id] }),
  productVariant: one(invProductVariants, { fields: [invQualityInspectionLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invQualityInspectionLines.locationId], references: [invLocations.id] }),
  planVersion: one(invInspectionPlanVersions, { fields: [invQualityInspectionLines.planVersionId], references: [invInspectionPlanVersions.id] }),
}));

export const invInspectionPlansRelations = relations(invInspectionPlans, ({ one, many }) => ({
  organization: one(organizations, { fields: [invInspectionPlans.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invInspectionPlans.productVariantId], references: [invProductVariants.id] }),
  product: one(invProducts, { fields: [invInspectionPlans.productId], references: [invProducts.id] }),
  category: one(invCategories, { fields: [invInspectionPlans.categoryId], references: [invCategories.id] }),
  creator: one(users, { fields: [invInspectionPlans.createdBy], references: [users.id], relationName: "ipCreator" }),
  versions: many(invInspectionPlanVersions),
}));

export const invInspectionPlanVersionsRelations = relations(invInspectionPlanVersions, ({ one }) => ({
  plan: one(invInspectionPlans, { fields: [invInspectionPlanVersions.planId], references: [invInspectionPlans.id] }),
  creator: one(users, { fields: [invInspectionPlanVersions.createdBy], references: [users.id], relationName: "ipvCreator" }),
}));

export const invQualityHoldsRelations = relations(invQualityHolds, ({ one }) => ({
  organization: one(organizations, { fields: [invQualityHolds.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invQualityHolds.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invQualityHolds.locationId], references: [invLocations.id] }),
  releasedByUser: one(users, { fields: [invQualityHolds.releasedBy], references: [users.id], relationName: "qhReleaser" }),
  creator: one(users, { fields: [invQualityHolds.createdBy], references: [users.id], relationName: "qhCreator" }),
}));

export const invRecallEventsRelations = relations(invRecallEvents, ({ one, many }) => ({
  organization: one(organizations, { fields: [invRecallEvents.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invRecallEvents.createdBy], references: [users.id] }),
  lines: many(invRecallLines),
}));

export const invRecallLinesRelations = relations(invRecallLines, ({ one }) => ({
  recall: one(invRecallEvents, { fields: [invRecallLines.recallId], references: [invRecallEvents.id] }),
  productVariant: one(invProductVariants, { fields: [invRecallLines.productVariantId], references: [invProductVariants.id] }),
}));
