import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invDockAppointmentStatusEnum, invDockDirectionEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invWarehouses } from "./warehouses";
import { invAsns } from "./quick-commerce";
import { invLoads } from "./shipping";

/**
 * NEO-12 - a door, and the hours it is open.
 *
 * The smallest thing that makes a dock schedulable. **Not a yard**: there is no
 * trailer, no parking bay, no gate move and no digital twin of the site.
 * Manhattan and Blue Yonder sell those, they are large, and half of one would be
 * worse than none - a yard that cannot tell you where a trailer is is a screen
 * people stop looking at.
 */
export const invDockDoors = pgTable("inv_dock_doors", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  /** What is painted on the door. The only identifier a driver is given. */
  code: text("code").notNull(),
  name: text("name"),
  /**
   * Which way goods move through it. Null means either, which is the common case
   * for a small site with two doors and no ceremony about it.
   */
  direction: invDockDirectionEnum("direction"),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_dock_doors_org_warehouse_code").on(table.orgId, table.warehouseId, table.code),
  unique("uniq_inv_dock_doors_org_id").on(table.orgId, table.id),
  index("idx_inv_dock_doors_org_warehouse").on(table.orgId, table.warehouseId),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_dock_doors_warehouse_org",
  }).onDelete("cascade"),
]);

/**
 * NEO-12 - somebody has a slot at a door.
 *
 * The collision rule is a database constraint, not a service check, and that is
 * the whole reason this table is worth having: two clerks booking the same door
 * at the same time both pass a read, and only Postgres can settle it. The
 * exclusion constraint is added in the migration with `btree_gist`, over the
 * door and the time range, ignoring cancelled and no-show rows.
 *
 * `asnId` and `loadId` are an exclusive arc rather than a polymorphic pair
 * (backend/CLAUDE.md S3): each is a real foreign key with real integrity, and a
 * CHECK keeps at most one set. An appointment may name neither - a slot booked
 * before the paperwork exists is an ordinary thing at a dock.
 */
export const invDockAppointments = pgTable("inv_dock_appointments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }).notNull(),
  doorId: integer("door_id").references(() => invDockDoors.id, { onDelete: "restrict" }).notNull(),
  direction: invDockDirectionEnum("direction").notNull(),
  status: invDockAppointmentStatusEnum("status").default("BOOKED").notNull(),
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end").notNull(),
  carrierName: text("carrier_name"),
  vehicleRef: text("vehicle_ref"),
  reference: text("reference"),
  /** Inbound: the shipment that was announced. */
  asnId: integer("asn_id").references(() => invAsns.id, { onDelete: "set null" }),
  /** Outbound: the load being built. */
  loadId: integer("load_id").references(() => invLoads.id, { onDelete: "set null" }),
  arrivedAt: timestamp("arrived_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_dock_appointments_org_id").on(table.orgId, table.id),
  index("idx_inv_dock_appointments_org_warehouse_window")
    .on(table.orgId, table.warehouseId, table.windowStart),
  index("idx_inv_dock_appointments_org_door_window").on(table.orgId, table.doorId, table.windowStart),
  index("idx_inv_dock_appointments_org_asn")
    .on(table.orgId, table.asnId)
    .where(sql`asn_id IS NOT NULL`),
  foreignKey({
    columns: [table.orgId, table.doorId],
    foreignColumns: [invDockDoors.orgId, invDockDoors.id],
    name: "fk_inv_dock_appointments_door_org",
  }),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_dock_appointments_warehouse_org",
  }).onDelete("cascade"),
  check("chk_inv_dock_appointments_window", sql`${table.windowEnd} > ${table.windowStart}`),
  // The exclusive arc. An appointment is for a shipment or for a load, not both.
  check(
    "chk_inv_dock_appointments_arc",
    sql`(${table.asnId} IS NULL) OR (${table.loadId} IS NULL)`,
  ),
]);

export const invDockDoorsRelations = relations(invDockDoors, ({ one, many }) => ({
  organization: one(organizations, { fields: [invDockDoors.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invDockDoors.warehouseId], references: [invWarehouses.id] }),
  appointments: many(invDockAppointments),
}));

export const invDockAppointmentsRelations = relations(invDockAppointments, ({ one }) => ({
  door: one(invDockDoors, { fields: [invDockAppointments.doorId], references: [invDockDoors.id] }),
  warehouse: one(invWarehouses, { fields: [invDockAppointments.warehouseId], references: [invWarehouses.id] }),
  asn: one(invAsns, { fields: [invDockAppointments.asnId], references: [invAsns.id] }),
}));
