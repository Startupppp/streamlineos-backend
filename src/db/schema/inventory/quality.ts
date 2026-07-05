import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invQualityInspectionStatusEnum, invQualityHoldStatusEnum,
  invQualityDispositionEnum, invRecallStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { invProductVariants } from "./core";
import { invLocations } from "./warehouses";

export const invQualityInspections = pgTable("inv_quality_inspections", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  inspectionNumber: text("inspection_number").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  status: invQualityInspectionStatusEnum("status").default("PENDING").notNull(),
  inspectorUserId: text("inspector_user_id").references(() => users.id),
  notes: text("notes"),
  completedAt: timestamp("completed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_qi_org_number").on(table.orgId, table.inspectionNumber),
  index("idx_inv_qi_org_status").on(table.orgId, table.status),
  index("idx_inv_qi_source").on(table.orgId, table.sourceType, table.sourceId),
]);

export const invQualityInspectionLines = pgTable("inv_quality_inspection_lines", {
  id: serial("id").primaryKey(),
  inspectionId: integer("inspection_id").references(() => invQualityInspections.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id"),
  serialId: integer("serial_id"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  result: text("result"),
  notes: text("notes"),
  disposition: invQualityDispositionEnum("disposition"),
}, (table) => [
  index("idx_inv_qi_lines_insp").on(table.inspectionId),
]);

export const invQualityHolds = pgTable("inv_quality_holds", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  lotId: integer("lot_id"),
  serialId: integer("serial_id"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  reason: text("reason").notNull(),
  status: invQualityHoldStatusEnum("status").default("ACTIVE").notNull(),
  releasedBy: text("released_by").references(() => users.id),
  releasedAt: timestamp("released_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
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
  createdBy: text("created_by").references(() => users.id).notNull(),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_recall_org_number").on(table.orgId, table.recallNumber),
  index("idx_inv_recall_org_status").on(table.orgId, table.status),
]);

export const invRecallLines = pgTable("inv_recall_lines", {
  id: serial("id").primaryKey(),
  recallId: integer("recall_id").references(() => invRecallEvents.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id),
  lotId: integer("lot_id"),
  serialId: integer("serial_id"),
  status: text("status").default("OPEN").notNull(),
}, (table) => [
  index("idx_inv_recall_lines_recall").on(table.recallId),
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
