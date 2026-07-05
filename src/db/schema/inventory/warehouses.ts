import { pgTable, text, serial, timestamp, boolean, decimal, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invLocationTypeEnum } from "../enums";
import { organizations, users } from "../auth";
import { orgBranches } from "../organization";

export const invWarehouses = pgTable("inv_warehouses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  branchId: text("branch_id").references(() => orgBranches.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  code: text("code").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  country: text("country"),
  managerUserId: text("manager_user_id").references(() => users.id, { onDelete: "set null" }),
  isDefault: boolean("is_default").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_warehouses_org_code").on(table.orgId, table.code),
  index("idx_inv_warehouses_org").on(table.orgId),
  index("idx_inv_warehouses_branch").on(table.branchId),
]);

export const invLocations = pgTable("inv_locations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  parentLocationId: integer("parent_location_id"),
  name: text("name").notNull(),
  code: text("code").notNull(),
  locationType: invLocationTypeEnum("location_type").notNull(),
  isPickable: boolean("is_pickable").default(true),
  isReceivable: boolean("is_receivable").default(true),
  isSellable: boolean("is_sellable").default(true),
  capacity: decimal("capacity", { precision: 18, scale: 4 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_locations_warehouse_code").on(table.warehouseId, table.code),
  index("idx_inv_locations_org").on(table.orgId),
  index("idx_inv_locations_warehouse").on(table.warehouseId),
  index("idx_inv_locations_parent").on(table.parentLocationId),
]);

export const invWarehousesRelations = relations(invWarehouses, ({ one, many }) => ({
  organization: one(organizations, { fields: [invWarehouses.orgId], references: [organizations.id] }),
  branch: one(orgBranches, { fields: [invWarehouses.branchId], references: [orgBranches.id] }),
  manager: one(users, { fields: [invWarehouses.managerUserId], references: [users.id], relationName: "warehouseManager" }),
  creator: one(users, { fields: [invWarehouses.createdBy], references: [users.id], relationName: "warehouseCreator" }),
  locations: many(invLocations),
}));

export const invLocationsRelations = relations(invLocations, ({ one, many }) => ({
  organization: one(organizations, { fields: [invLocations.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invLocations.warehouseId], references: [invWarehouses.id] }),
  parent: one(invLocations, { fields: [invLocations.parentLocationId], references: [invLocations.id], relationName: "locationParent" }),
  children: many(invLocations, { relationName: "locationParent" }),
}));
