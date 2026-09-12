/**
 * Pick lists and their lines: the work of taking stock off a shelf.
 *
 * A line is where a pick exception is recorded — short, not found, damaged,
 * substituted, wrong location — together with the review state and resolution
 * that say whether a supervisor agreed with what the picker did.
 *
 * Moved verbatim out of `operations.ts`; see also `./returns` and `./counting`.
 */

import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  invPickListStatusEnum,
  invPickExceptionEnum,
  invPickExceptionStatusEnum,
  invPickExceptionResolutionEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invSalesOrders, invSoLines } from "./sales-orders";
import { invLots, invSerialNumbers } from "./traceability";

export const invPickLists = pgTable("inv_pick_lists", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pickNumber: text("pick_number").notNull(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }),
  status: invPickListStatusEnum("status").default("PENDING").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  /**
   * B4. Who is walking this wave, which is not who created it.
   *
   * Held exclusively: a claim is a conditional update that only fires while
   * this is null, so two pickers handed the same wave cannot both walk it. Each
   * confirm is already bounded by `quantity_to_pick`, so the second picker's
   * confirm would be refused -- but only after they had taken the goods off the
   * shelf, and a double count that is physical before it is numeric can only be
   * prevented before the walk.
   */
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at"),
  createdByMembershipId: integer("created_by_membership_id"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_pick_org_number").on(table.orgId, table.pickNumber),
  unique("uniq_inv_pick_lists_org_id").on(table.orgId, table.id),
  index("idx_inv_pick_org_status").on(table.orgId, table.status),
  index("idx_inv_pick_org_assignee").on(table.orgId, table.assignedTo, table.status),
]);

export const invPickListLines = pgTable("inv_pick_list_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pickListId: integer("pick_list_id").references(() => invPickLists.id, { onDelete: "cascade" }).notNull(),
  soLineId: integer("so_line_id").references(() => invSoLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  /**
   * NEO-4 - the handling unit picked from, or null for loose stock in the bin.
   *
   * It has to be here for the same reason lot and serial are: `EXPECTED_OUTGOING`
   * matches a pick line against a stock-level row on the row's full natural key,
   * and the handling unit is now part of that key. Without it, two units off a
   * pallet would zero the `outgoing_qty` of the loose stock on the same shelf and
   * re-offer units that are standing in a tote - the exact defect that comment in
   * `projection-definitions.ts` was written about.
   */
  handlingUnitId: integer("handling_unit_id"),
  quantityToPick: decimal("quantity_to_pick", { precision: 18, scale: 4 }).notNull(),
  quantityPicked: decimal("quantity_picked", { precision: 18, scale: 4 }).default("0").notNull(),
  /**
   * INV-205. Why the rest was not picked. Null means the line closed as asked,
   * which is the common case; a short pick with no reason and a short pick
   * because the shelf was empty are different facts and a warehouse that
   * cannot tell them apart fixes neither.
   */
  exceptionReason: invPickExceptionEnum("exception_reason"),
  exceptionNotes: text("exception_notes"),
  /**
   * B5. An exception with nobody's name on it is a note, not a task.
   *
   * The owner is the person who has to do something about it, and it defaults to
   * whoever planned the walk rather than to the picker who found it: a picker at
   * a shelf cannot decide whether an order ships short. Reassignable, because
   * the planner is not always the person who ends up holding it.
   */
  exceptionOwnerId: text("exception_owner_id").references(() => users.id, { onDelete: "set null" }),
  /**
   * `OPEN` until somebody reviews it. Non-null exactly when `exception_reason`
   * is, which is a CHECK rather than a convention — the two drifting apart is
   * how a queue starts missing rows.
   */
  exceptionStatus: invPickExceptionStatusEnum("exception_status"),
  /** Set exactly when the status is RESOLVED, enforced by a CHECK. */
  exceptionResolution: invPickExceptionResolutionEnum("exception_resolution"),
  exceptionResolutionNotes: text("exception_resolution_notes"),
  exceptionReportedBy: text("exception_reported_by").references(() => users.id, { onDelete: "set null" }),
  exceptionReportedAt: timestamp("exception_reported_at"),
  exceptionResolvedBy: text("exception_resolved_by").references(() => users.id, { onDelete: "set null" }),
  exceptionResolvedAt: timestamp("exception_resolved_at"),
  /**
   * B5. Where the goods actually were, on a `WRONG_LOCATION` report.
   *
   * Evidence rather than a correction: the line is retargeted to it so the
   * picker can finish the walk, and the discrepancy survives on the row for a
   * cycle count to chase. Without it "the wave sent me to the wrong bin" is a
   * note in free text nobody can query.
   */
  exceptionLocationId: integer("exception_location_id").references(() => invLocations.id, { onDelete: "set null" }),
  /** What actually went in the tote, when the picker swapped one item for another. */
  substituteVariantId: integer("substitute_variant_id"),
  /**
   * How much of the substitute went in. Separate from `quantityPicked`, which
   * means what it says: how much of *this line's* variant was picked. Folding
   * the substitute into it made packing believe units of the original had been
   * picked that never were.
   */
  substituteQuantity: decimal("substitute_quantity", { precision: 18, scale: 4 }),
}, (table) => [
  unique("uniq_inv_pick_list_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.pickListId],
    foreignColumns: [invPickLists.orgId, invPickLists.id],
    name: "fk_inv_pick_list_lines_pick_list_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_pick_list_lines_product_variant_id_org",
  }),
  index("idx_inv_pick_lines_pick").on(table.pickListId),
  index("idx_inv_pick_list_lines_variant").on(table.productVariantId),
  // B5. The supervisor queue reads open exceptions across every wave, so the
  // index is partial on the rows that are exceptions at all — the table is
  // mostly lines that closed as asked, and a full index on `exception_status`
  // would be almost entirely nulls.
  index("idx_inv_pick_lines_exception_queue")
    .on(table.orgId, table.exceptionStatus, table.id)
    .where(sql`${table.exceptionReason} IS NOT NULL`),
]);

export const invPickListsRelations = relations(invPickLists, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPickLists.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invPickLists.createdBy], references: [users.id] }),
  lines: many(invPickListLines),
}));

export const invPickListLinesRelations = relations(invPickListLines, ({ one }) => ({
  pickList: one(invPickLists, { fields: [invPickListLines.pickListId], references: [invPickLists.id] }),
  productVariant: one(invProductVariants, { fields: [invPickListLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invPickListLines.locationId], references: [invLocations.id] }),
}));
