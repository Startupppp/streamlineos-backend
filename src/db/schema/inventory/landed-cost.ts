import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  timestamp,
  decimal,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invLandedCostStatusEnum,
  invLandedCostBasisEnum,
  invLandedCostChargeTypeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invGrns, invVendors } from "./purchase-orders";
import { invValuationLayers } from "./valuation";

/**
 * G5 — freight, duty and handling, against the receipt they belong to.
 *
 * A landed-cost voucher is its own document rather than a field on the goods
 * receipt, because the two arrive at different times and from different people.
 * The pallet is counted at the dock; the carrier's invoice turns up a fortnight
 * later, on a different desk, and often covers several receipts at once. A
 * column on `inv_grns` would force the receipt to wait for the freight bill, and
 * the whole point of receiving is that it does not wait for anything.
 *
 * Because the stock ledger is append-only — a BEFORE UPDATE trigger refuses any
 * change to `unit_cost` or `total_cost` on `inv_stock_transactions` — an applied
 * voucher does not restate the receipt's movement. It revalues the *cost layers*
 * the receipt created, which are mutable by design (`commitIssue` decrements
 * `remaining_quantity` on every issue), and it books the share belonging to
 * goods that have already left as a period cost. Nothing here posts a stock
 * movement, so on-hand never changes.
 */
export const invLandedCostVouchers = pgTable("inv_landed_cost_vouchers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /** The receipt whose layers this voucher costs. One voucher, one receipt. */
  grnId: integer("grn_id").references(() => invGrns.id, { onDelete: "cascade" }).notNull(),
  voucherNumber: text("voucher_number").notNull(),
  status: invLandedCostStatusEnum("status").default("DRAFT").notNull(),
  /**
   * VALUE spreads a charge in proportion to what each layer was worth, QUANTITY
   * in proportion to how many units it holds. Neither is a default anybody can
   * infer: duty follows value, pallet handling follows volume, and picking one
   * silently would misstate the other.
   */
  allocationBasis: invLandedCostBasisEnum("allocation_basis").default("VALUE").notNull(),
  currency: text("currency").default("INR").notNull(),
  /**
   * The sum of this voucher's charges, in integer minor units. Money is cents
   * here and nowhere in this module is it a float; the valuation columns beside
   * it are `numeric(18,4)` because that is the grain cost layers are kept at, and
   * the conversion between the two is exact (one cent is 0.0100).
   */
  chargeTotalCents: bigint("charge_total_cents", { mode: "bigint" }).default(0n).notNull(),
  /** What `apply` actually added to cost layers, and what it had to expense. */
  capitalisedValue: decimal("capitalised_value", { precision: 18, scale: 4 }).default("0").notNull(),
  expensedValue: decimal("expensed_value", { precision: 18, scale: 4 }).default("0").notNull(),
  notes: text("notes"),
  appliedAt: timestamp("applied_at"),
  appliedBy: text("applied_by").references(() => users.id),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_landed_cost_vouchers_org_number").on(table.orgId, table.voucherNumber),
  unique("uniq_inv_landed_cost_vouchers_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.grnId],
    foreignColumns: [invGrns.orgId, invGrns.id],
    name: "fk_inv_landed_cost_vouchers_grn_org",
  }),
  index("idx_inv_landed_cost_vouchers_org_grn").on(table.orgId, table.grnId),
  index("idx_inv_landed_cost_vouchers_org_status").on(table.orgId, table.status, table.createdAt),
]);

/**
 * One charge on a voucher — a carrier's invoice line, a customs assessment, a
 * handling fee.
 *
 * A row per charge rather than three columns on the header, for the reason §3
 * gives about JSONB arrays and for one specific to money: a voucher routinely
 * carries several charges from several suppliers, each with its own reference,
 * and "which invoice was this" is the first question asked when the numbers are
 * challenged.
 *
 * The single-column foreign keys here and on `inv_landed_cost_allocations` are
 * declared through `foreignKey({ name })` rather than an inline `.references()`,
 * and their names are short.
 *
 * A Postgres identifier is 63 bytes and anything longer is silently truncated.
 * Drizzle's generated name for these — `<table>_<column>_<ftable>_<fcolumn>_fk` —
 * runs to 65-73 characters here, so the constraint would be stored under a name
 * nothing in the migration or the schema ever writes down, and the migration's
 * "does this constraint already exist" guard would never match it. That does not
 * fail on the first run; it fails on the second, with "constraint already exists"
 * for a constraint it had just failed to find.
 */
export const invLandedCostCharges = pgTable("inv_landed_cost_charges", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  voucherId: integer("voucher_id").notNull(),
  chargeType: invLandedCostChargeTypeEnum("charge_type").notNull(),
  description: text("description").notNull(),
  /** Integer minor units, always positive. A credit note is not a landed cost. */
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  /** Who billed it, where the biller is on file. Freight is rarely the goods vendor. */
  vendorId: integer("vendor_id").references(() => invVendors.id, { onDelete: "set null" }),
  reference: text("reference"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_landed_cost_charges_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.voucherId],
    foreignColumns: [invLandedCostVouchers.id],
    name: "fk_inv_lc_charges_voucher",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.voucherId],
    foreignColumns: [invLandedCostVouchers.orgId, invLandedCostVouchers.id],
    name: "fk_inv_landed_cost_charges_voucher_org",
  }),
  index("idx_inv_landed_cost_charges_org_voucher").on(table.orgId, table.voucherId),
]);

/**
 * Where every fraction of the voucher went, one row per cost layer it touched.
 *
 * This is the table that makes the apportionment auditable rather than asserted.
 * It records the weight the layer carried, the amount it was allocated, how much
 * of that amount reached the layer (`capitalised_value`) and how much could not
 * (`expensed_value`, the share belonging to units that had already been issued
 * before the freight bill arrived), plus the unit cost either side of the
 * revaluation. `allocated_value = capitalised_value + expensed_value` on every
 * row, and the rows sum to the voucher's charge total exactly.
 *
 * `valuation_layer_id` is nullable because a STANDARD-cost variant capitalises
 * nothing by definition: its cost is the standard, so the whole allocation is a
 * purchase price variance and there is no layer to point at.
 */
export const invLandedCostAllocations = pgTable("inv_landed_cost_allocations", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  voucherId: integer("voucher_id").notNull(),
  valuationLayerId: integer("valuation_layer_id"),
  productVariantId: integer("product_variant_id").notNull(),
  /** FIFO · WEIGHTED_AVERAGE · STANDARD, as it stood when the voucher applied. */
  costingMethod: text("costing_method").notNull(),
  /** The weight this layer carried in the apportionment, in the chosen basis. */
  weight: decimal("weight", { precision: 18, scale: 4 }).notNull(),
  allocatedValue: decimal("allocated_value", { precision: 18, scale: 4 }).notNull(),
  capitalisedValue: decimal("capitalised_value", { precision: 18, scale: 4 }).notNull(),
  expensedValue: decimal("expensed_value", { precision: 18, scale: 4 }).notNull(),
  layerQuantity: decimal("layer_quantity", { precision: 18, scale: 4 }).notNull(),
  /** How much of the layer was still in stock when the voucher applied. */
  remainingQuantity: decimal("remaining_quantity", { precision: 18, scale: 4 }).notNull(),
  unitCostBefore: decimal("unit_cost_before", { precision: 18, scale: 4 }).notNull(),
  unitCostAfter: decimal("unit_cost_after", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_landed_cost_allocations_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.voucherId],
    foreignColumns: [invLandedCostVouchers.id],
    name: "fk_inv_lc_allocations_voucher",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.valuationLayerId],
    foreignColumns: [invValuationLayers.id],
    name: "fk_inv_lc_allocations_layer",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.productVariantId],
    foreignColumns: [invProductVariants.id],
    name: "fk_inv_lc_allocations_variant",
  }).onDelete("restrict"),
  uniqueIndex("uniq_inv_landed_cost_allocations_voucher_layer").on(
    table.orgId,
    table.voucherId,
    table.valuationLayerId,
  ),
  foreignKey({
    columns: [table.orgId, table.voucherId],
    foreignColumns: [invLandedCostVouchers.orgId, invLandedCostVouchers.id],
    name: "fk_inv_landed_cost_allocations_voucher_org",
  }),
  foreignKey({
    columns: [table.orgId, table.valuationLayerId],
    foreignColumns: [invValuationLayers.orgId, invValuationLayers.id],
    name: "fk_inv_landed_cost_allocations_layer_org",
  }),
  index("idx_inv_landed_cost_allocations_org_voucher").on(table.orgId, table.voucherId),
  index("idx_inv_landed_cost_allocations_org_layer").on(table.orgId, table.valuationLayerId),
]);

export const invLandedCostVouchersRelations = relations(invLandedCostVouchers, ({ one, many }) => ({
  organization: one(organizations, { fields: [invLandedCostVouchers.orgId], references: [organizations.id] }),
  goodsReceipt: one(invGrns, { fields: [invLandedCostVouchers.grnId], references: [invGrns.id] }),
  creator: one(users, { fields: [invLandedCostVouchers.createdBy], references: [users.id] }),
  applier: one(users, { fields: [invLandedCostVouchers.appliedBy], references: [users.id] }),
  charges: many(invLandedCostCharges),
  allocations: many(invLandedCostAllocations),
}));

export const invLandedCostChargesRelations = relations(invLandedCostCharges, ({ one }) => ({
  voucher: one(invLandedCostVouchers, {
    fields: [invLandedCostCharges.voucherId],
    references: [invLandedCostVouchers.id],
  }),
  vendor: one(invVendors, { fields: [invLandedCostCharges.vendorId], references: [invVendors.id] }),
}));

export const invLandedCostAllocationsRelations = relations(invLandedCostAllocations, ({ one }) => ({
  voucher: one(invLandedCostVouchers, {
    fields: [invLandedCostAllocations.voucherId],
    references: [invLandedCostVouchers.id],
  }),
  layer: one(invValuationLayers, {
    fields: [invLandedCostAllocations.valuationLayerId],
    references: [invValuationLayers.id],
  }),
  productVariant: one(invProductVariants, {
    fields: [invLandedCostAllocations.productVariantId],
    references: [invProductVariants.id],
  }),
}));
