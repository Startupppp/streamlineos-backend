/**
 * Counting what is actually there: cycle counts and physical audits.
 *
 * Two documents with the same shape and different scope — a cycle count is a
 * rolling sample of locations worked continuously, a physical audit is the
 * whole-warehouse stop-and-count. Both hold a counted quantity per line beside
 * the system quantity, and neither writes the ledger until it is posted.
 *
 * Moved verbatim out of `operations.ts`; see also `./returns` and `./picking`.
 */

import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invCycleCountStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants, invCategories } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invLots } from "./traceability";

export const invCycleCounts = pgTable("inv_cycle_counts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  countNumber: text("count_number").notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  categoryId: integer("category_id").references(() => invCategories.id, { onDelete: "set null" }),
  status: invCycleCountStatusEnum("status").default("PLANNED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedByMembershipId: integer("approved_by_membership_id"),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_cc_org_number").on(table.orgId, table.countNumber),
  unique("uniq_inv_cycle_counts_org_id").on(table.orgId, table.id),
  index("idx_inv_cc_org_status").on(table.orgId, table.status),
]);

export const invCycleCountLines = pgTable("inv_cycle_count_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  cycleCountId: integer("cycle_count_id").references(() => invCycleCounts.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  systemQty: decimal("system_qty", { precision: 18, scale: 4 }).notNull(),
  countedQty: decimal("counted_qty", { precision: 18, scale: 4 }),
  varianceQty: decimal("variance_qty", { precision: 18, scale: 4 }),
}, (table) => [
  unique("uniq_inv_cycle_count_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.cycleCountId],
    foreignColumns: [invCycleCounts.orgId, invCycleCounts.id],
    name: "fk_inv_cycle_count_lines_cycle_count_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_cycle_count_lines_product_variant_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.locationId],
    foreignColumns: [invLocations.orgId, invLocations.id],
    name: "fk_inv_cycle_count_lines_location_id_org",
  }),
  index("idx_inv_cc_lines_count").on(table.cycleCountId),
  index("idx_inv_cycle_count_lines_variant").on(table.productVariantId),
]);

export const invPhysicalAudits = pgTable("inv_physical_audits", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  auditNumber: text("audit_number").notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }).notNull(),
  status: invCycleCountStatusEnum("status").default("PLANNED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedByMembershipId: integer("approved_by_membership_id"),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_pa_org_number").on(table.orgId, table.auditNumber),
  unique("uniq_inv_physical_audits_org_id").on(table.orgId, table.id),
  index("idx_inv_pa_org_status").on(table.orgId, table.status),
]);

export const invPhysicalAuditLines = pgTable("inv_physical_audit_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  auditId: integer("audit_id").references(() => invPhysicalAudits.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  systemQty: decimal("system_qty", { precision: 18, scale: 4 }).notNull(),
  countedQty: decimal("counted_qty", { precision: 18, scale: 4 }),
  varianceQty: decimal("variance_qty", { precision: 18, scale: 4 }),
}, (table) => [
  unique("uniq_inv_physical_audit_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.auditId],
    foreignColumns: [invPhysicalAudits.orgId, invPhysicalAudits.id],
    name: "fk_inv_physical_audit_lines_audit_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_physical_audit_lines_product_variant_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.locationId],
    foreignColumns: [invLocations.orgId, invLocations.id],
    name: "fk_inv_physical_audit_lines_location_id_org",
  }),
  index("idx_inv_pa_lines_audit").on(table.auditId),
  index("idx_inv_physical_audit_lines_variant").on(table.productVariantId),
]);

export const invCycleCountsRelations = relations(invCycleCounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [invCycleCounts.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invCycleCounts.createdBy], references: [users.id], relationName: "ccCreator" }),
  approver: one(users, { fields: [invCycleCounts.approvedBy], references: [users.id], relationName: "ccApprover" }),
  lines: many(invCycleCountLines),
}));

export const invCycleCountLinesRelations = relations(invCycleCountLines, ({ one }) => ({
  cycleCount: one(invCycleCounts, { fields: [invCycleCountLines.cycleCountId], references: [invCycleCounts.id] }),
  productVariant: one(invProductVariants, { fields: [invCycleCountLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invCycleCountLines.locationId], references: [invLocations.id] }),
}));

export const invPhysicalAuditsRelations = relations(invPhysicalAudits, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPhysicalAudits.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invPhysicalAudits.createdBy], references: [users.id], relationName: "paCreator" }),
  approver: one(users, { fields: [invPhysicalAudits.approvedBy], references: [users.id], relationName: "paApprover" }),
  lines: many(invPhysicalAuditLines),
}));

export const invPhysicalAuditLinesRelations = relations(invPhysicalAuditLines, ({ one }) => ({
  audit: one(invPhysicalAudits, { fields: [invPhysicalAuditLines.auditId], references: [invPhysicalAudits.id] }),
  productVariant: one(invProductVariants, { fields: [invPhysicalAuditLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invPhysicalAuditLines.locationId], references: [invLocations.id] }),
}));
