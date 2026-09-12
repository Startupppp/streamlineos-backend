import { pgTable, text, serial, timestamp, integer, jsonb, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invHandlingUnitStatusEnum, invHandlingUnitKindEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invLocations } from "./warehouses";

/**
 * NEO-4 - a handling unit: the pallet, cage or carton stock is actually standing
 * on.
 *
 * Before this, the finest thing Streamline could name was a bin. A warehouse
 * moves pallets, not bins: a putaway is "take LPN 000123 to A-04-2", a pick is
 * "two off LPN 000123", and a truck is loaded with LPNs. Without the unit, every
 * one of those instructions has to be re-expressed as a quantity of a SKU at a
 * location, which is both a translation the floor has to do in its head and a
 * loss of the one identifier the label actually carries. SAP EWM and Manhattan
 * both refuse to take a warehouse without it.
 *
 * ## Stock lives on leaves, and only on leaves
 *
 * `parentHuId` nests: cartons on a pallet, pallets in a cage. **Stock is held
 * against a leaf handling unit and never against a parent.** A parent's contents
 * are the union of its children's, computed, never stored.
 *
 * That invariant is what makes "nested carton does not double-count" true by
 * construction rather than by care: there is no second place the same twelve
 * units could be written down. `HandlingUnitService` refuses to pack stock into
 * a unit that has children and refuses to nest a child under a unit that holds
 * stock, so the two states cannot both exist.
 *
 * ## It is not a package
 *
 * `inv_packages` (B6) is a shipping carton: what went in a parcel, for a label
 * and a manifest. It posts no stock and never did. A handling unit is where
 * stock *is*. A package may reference the handling unit it was built from; they
 * are not the same row and must not be merged, because a package is finished
 * when the parcel is sealed and a handling unit outlives every shipment it is
 * part of.
 */
export const invHandlingUnits = pgTable("inv_handling_units", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /**
   * The label the unit actually wears. An SSCC where the organisation issues
   * them, an internal LPN otherwise - one column either way, because the floor
   * scans whatever is printed and does not care which scheme minted it.
   */
  huCode: text("hu_code").notNull(),
  kind: invHandlingUnitKindEnum("kind").default("PALLET").notNull(),
  status: invHandlingUnitStatusEnum("status").default("OPEN").notNull(),
  /** Null while nested: a child's whereabouts is its parent's. */
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  parentHuId: integer("parent_hu_id"),
  /** Free-form label data the floor prints - carrier ref, build note. Never quantities. */
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  closedAt: timestamp("closed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_handling_units_org_code").on(table.orgId, table.huCode),
  unique("uniq_inv_handling_units_org_id").on(table.orgId, table.id),
  index("idx_inv_handling_units_org_location").on(table.orgId, table.locationId),
  index("idx_inv_handling_units_org_parent").on(table.orgId, table.parentHuId),
  index("idx_inv_handling_units_org_status").on(table.orgId, table.status),
  foreignKey({
    columns: [table.orgId, table.parentHuId],
    foreignColumns: [table.orgId, table.id],
    name: "fk_inv_handling_units_parent_org",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.locationId],
    foreignColumns: [invLocations.orgId, invLocations.id],
    name: "fk_inv_handling_units_location_org",
  }).onDelete("set null"),
  // A unit cannot be inside itself. The service walks the whole chain before
  // nesting; this catches the one-hop case against a direct write.
  check("chk_inv_handling_units_not_self_parent", sql`${table.parentHuId} IS DISTINCT FROM ${table.id}`),
  // Nested or placed, never both and never neither once it holds anything: a
  // child's location is its parent's, and a root with no location is stock
  // nobody can find.
  check(
    "chk_inv_handling_units_placed_xor_nested",
    sql`(${table.parentHuId} IS NULL) OR (${table.locationId} IS NULL)`,
  ),
]);

export const invHandlingUnitsRelations = relations(invHandlingUnits, ({ one, many }) => ({
  organization: one(organizations, { fields: [invHandlingUnits.orgId], references: [organizations.id] }),
  location: one(invLocations, { fields: [invHandlingUnits.locationId], references: [invLocations.id] }),
  parent: one(invHandlingUnits, {
    fields: [invHandlingUnits.parentHuId],
    references: [invHandlingUnits.id],
    relationName: "hu_nesting",
  }),
  children: many(invHandlingUnits, { relationName: "hu_nesting" }),
}));
