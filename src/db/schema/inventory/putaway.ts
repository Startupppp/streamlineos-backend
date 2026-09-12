import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invPutawayStatusEnum, invPutawayDispositionEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invGrns } from "./purchase-orders";
import { invLots, invSerialNumbers } from "./traceability";

/**
 * B3 — the walk between the dock and the shelf.
 *
 * A goods receipt lands every accepted unit on one location, and until now that
 * was where they stayed: the suggestion endpoint could say where they ought to
 * go and nothing recorded that anybody had taken them there. So receiving bins
 * accumulated stock that the pick face never saw, and "is this delivery put
 * away" was a question only a person walking the aisle could answer.
 *
 * The task is the document that closes that gap. It names where the goods are
 * now, what quantity of which grain is standing there, and — per line — where
 * each grain is meant to end up. Completing it is a transfer-like movement
 * through the stock engine, so the ledger, the valuation layers and the
 * capacity check all apply exactly as they do to any other relocation.
 */
export const invPutawayTasks = pgTable("inv_putaway_tasks", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  taskNumber: text("task_number").notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }).notNull(),
  /**
   * The receipt these goods arrived on. Nullable because a receipt may be
   * removed long after its stock has been put away, and losing the provenance
   * is better than losing the task.
   */
  grnId: integer("grn_id").references(() => invGrns.id, { onDelete: "set null" }),
  /** Where the goods are standing now — the receiving location the GRN posted to. */
  fromLocationId: integer("from_location_id").references(() => invLocations.id, { onDelete: "restrict" }).notNull(),
  status: invPutawayStatusEnum("status").default("PENDING").notNull(),
  /**
   * Who is walking it. Held exclusively, like a pick wave: a claim is a
   * conditional update that fires only while this is null, so two operators
   * handed the same task cannot both carry the same pallet.
   */
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_putaway_tasks_org_number").on(table.orgId, table.taskNumber),
  unique("uniq_inv_putaway_tasks_org_id").on(table.orgId, table.id),
  index("idx_inv_putaway_tasks_org_status").on(table.orgId, table.status, table.createdAt),
  index("idx_inv_putaway_tasks_org_assignee").on(table.orgId, table.assignedTo, table.status),
  index("idx_inv_putaway_tasks_org_grn").on(table.orgId, table.grnId),
]);

/**
 * One grain of one receipt, and where it is going.
 *
 * The grain is (variant, lot, serial), matching `inv_stock_levels` — a line
 * keyed on the variant alone could not put away two lots of the same SKU to
 * different bins, and could not carry a serial at all.
 */
export const invPutawayTaskLines = pgTable("inv_putaway_task_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  taskId: integer("task_id").references(() => invPutawayTasks.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  /** How much of it has actually been walked, so a partial putaway is a state and not a loss. */
  quantityMoved: decimal("quantity_moved", { precision: 18, scale: 4 }).default("0").notNull(),
  disposition: invPutawayDispositionEnum("disposition").default("STORAGE").notNull(),
  /**
   * Where it should go. A suggestion at creation for a STORAGE line — the
   * operator may confirm a different bin — and the quarantine location for a
   * QUARANTINE one, where it is not a suggestion at all.
   */
  toLocationId: integer("to_location_id").references(() => invLocations.id, { onDelete: "set null" }),
}, (table) => [
  unique("uniq_inv_putaway_task_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.taskId],
    foreignColumns: [invPutawayTasks.orgId, invPutawayTasks.id],
    name: "fk_inv_putaway_task_lines_task_id_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_putaway_task_lines_product_variant_id_org",
  }),
  index("idx_inv_putaway_task_lines_task").on(table.taskId),
  index("idx_inv_putaway_task_lines_variant").on(table.orgId, table.productVariantId),
  check("chk_inv_putaway_task_lines_quantity", sql`quantity > 0`),
  check(
    "chk_inv_putaway_task_lines_moved",
    sql`quantity_moved >= 0 AND quantity_moved <= quantity`,
  ),
]);

export const invPutawayTasksRelations = relations(invPutawayTasks, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPutawayTasks.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invPutawayTasks.warehouseId], references: [invWarehouses.id] }),
  grn: one(invGrns, { fields: [invPutawayTasks.grnId], references: [invGrns.id] }),
  fromLocation: one(invLocations, { fields: [invPutawayTasks.fromLocationId], references: [invLocations.id] }),
  assignee: one(users, { fields: [invPutawayTasks.assignedTo], references: [users.id], relationName: "putawayAssignee" }),
  creator: one(users, { fields: [invPutawayTasks.createdBy], references: [users.id], relationName: "putawayCreator" }),
  lines: many(invPutawayTaskLines),
}));

export const invPutawayTaskLinesRelations = relations(invPutawayTaskLines, ({ one }) => ({
  task: one(invPutawayTasks, { fields: [invPutawayTaskLines.taskId], references: [invPutawayTasks.id] }),
  productVariant: one(invProductVariants, { fields: [invPutawayTaskLines.productVariantId], references: [invProductVariants.id] }),
  lot: one(invLots, { fields: [invPutawayTaskLines.lotId], references: [invLots.id] }),
  serial: one(invSerialNumbers, { fields: [invPutawayTaskLines.serialId], references: [invSerialNumbers.id] }),
  toLocation: one(invLocations, { fields: [invPutawayTaskLines.toLocationId], references: [invLocations.id] }),
}));
