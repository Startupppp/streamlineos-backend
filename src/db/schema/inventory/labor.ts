import { pgTable, text, serial, timestamp, integer, decimal, index, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invLaborTaskKindEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invWarehouses, invLocations } from "./warehouses";

/**
 * NEO-7 - one completed piece of floor work, and what it should have taken.
 *
 * A twenty-person warehouse currently runs on somebody's memory of who is quick.
 * This is the smallest honest alternative: what each confirmation was, who did
 * it, how long it took, and a standard to compare it against.
 *
 * **It is not payroll and cannot become payroll.** Nothing in this table is a
 * rate, an amount or an employee number, and nothing in this module writes to
 * one; `labor-standard.ts` documents the boundary and
 * `__tests__/labor.spec.ts` asserts it. A warehouse measuring pick rates and a
 * business paying piece rates are different systems, and the second needs
 * protections - grievance, correction, consent - that a stock module has no
 * business improvising.
 *
 * **`distanceProxy` is a proxy and says so.** It counts bin *changes*, not
 * metres: engineered labour standards need a surveyed building and a time study,
 * and neither exists here. Counting moves is defensible - a picker who walks to
 * eight bins did more work than one who took eight units off one shelf - and it
 * is honest about what it is. Anything calling itself a distance in metres would
 * be a number somebody would eventually put in a performance review.
 */
export const invLaborRecords = pgTable("inv_labor_records", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }),
  taskKind: invLaborTaskKindEnum("task_kind").notNull(),
  /** The document: a pick list, a putaway task, a count, a receipt. */
  taskId: integer("task_id").notNull(),
  /** The line within it, so a partial confirmation is its own record. */
  taskLineId: integer("task_line_id"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  /**
   * When the operator started this line. Taken from when the previous line on
   * the same task finished, or from the claim for the first - which is a proxy
   * too, and the alternative is asking a picker to press start.
   */
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at").notNull(),
  /** Units confirmed. Decimal, because a kirana line can be 0.750 kg. */
  unitsDone: decimal("units_done", { precision: 18, scale: 4 }).default("0").notNull(),
  scanCount: integer("scan_count").default(0).notNull(),
  /** Bin changes, not metres. See the note above. */
  distanceProxy: integer("distance_proxy").default(0).notNull(),
  /** What the standard said this should take. Stored, so a later change to the
   * standard does not silently restate last month's performance. */
  standardSeconds: integer("standard_seconds").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_labor_records_org_id").on(table.orgId, table.id),
  // The board's own query: one warehouse, one window, grouped by person.
  index("idx_inv_labor_records_org_warehouse_completed")
    .on(table.orgId, table.warehouseId, table.completedAt),
  index("idx_inv_labor_records_org_user_completed").on(table.orgId, table.userId, table.completedAt),
  index("idx_inv_labor_records_org_task").on(table.orgId, table.taskKind, table.taskId),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_labor_records_warehouse_org",
  }).onDelete("cascade"),
  // A line that finished before it started is a clock problem, not a fast picker.
  check("chk_inv_labor_records_window", sql`${table.completedAt} >= ${table.startedAt}`),
  check("chk_inv_labor_records_standard_positive", sql`${table.standardSeconds} > 0`),
]);

export const invLaborRecordsRelations = relations(invLaborRecords, ({ one }) => ({
  organization: one(organizations, { fields: [invLaborRecords.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invLaborRecords.warehouseId], references: [invWarehouses.id] }),
  location: one(invLocations, { fields: [invLaborRecords.locationId], references: [invLocations.id] }),
}));
