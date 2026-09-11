/**
 * Organisation-wide inventory configuration.
 *
 * `inv_settings` is the one row per tenant that every engine reads before it
 * decides anything — costing method, reservation strategy, expiry policy, the
 * vertical packs that are switched on — and `inv_number_sequences` is the
 * counter that names the documents those decisions produce. Both are settings a
 * person edits on a screen, which is what separates them from the machinery in
 * `./admin-integration` and the evidence in `./admin-compliance`.
 */

import { pgTable, text, serial, timestamp, decimal, integer, boolean, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invReservationStrategyEnum,
  invCostingMethodEnum,
  invExpiryPolicyEnum,
  invNearExpiryPolicyEnum,
  invGstModeEnum,
} from "../common/enums";
import { organizations } from "../common/auth";

export const invSettings = pgTable("inv_settings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull().unique(),
  allowNegativeStock: boolean("allow_negative_stock").default(false).notNull(),
  allowBackorders: boolean("allow_backorders").default(false).notNull(),
  reservationStrategy: invReservationStrategyEnum("reservation_strategy").default("AUTO_ON_CONFIRM").notNull(),
  defaultCostingMethod: invCostingMethodEnum("default_costing_method").default("WEIGHTED_AVERAGE").notNull(),
  expiryReservationPolicy: invExpiryPolicyEnum("expiry_reservation_policy").default("BLOCK").notNull(),
  inspectionOnReceipt: boolean("inspection_on_receipt").default(false).notNull(),
  inspectionOnReturn: boolean("inspection_on_return").default(false).notNull(),
  overReceiptTolerancePct: decimal("over_receipt_tolerance_pct", { precision: 5, scale: 2 }).default("0").notNull(),
  requirePoApproval: boolean("require_po_approval").default(false).notNull(),
  /**
   * INV-309. Above this order value a purchase order needs sign-off. Null means
   * the boolean above decides, which is every order or none — and "every order"
   * is how an approval policy ends up switched off entirely.
   */
  poApprovalThreshold: decimal("po_approval_threshold", { precision: 18, scale: 4 }),
  adjustmentApprovalThreshold: decimal("adjustment_approval_threshold", { precision: 18, scale: 4 }),
  adjustmentApprovalValueThreshold: decimal("adjustment_approval_value_threshold", { precision: 18, scale: 4 }),
  autoReserveOnConfirm: boolean("auto_reserve_on_confirm").default(true).notNull(),
  allowPartialShipment: boolean("allow_partial_shipment").default(true).notNull(),
  packageRequiredForShipping: boolean("package_required_for_shipping").default(false).notNull(),
  channelPublishPolicy: text("channel_publish_policy"),
  /**
   * E1 — the four packs, and which of them this organisation is running.
   *
   * A pack is a bundle of domain rules that only some organisations want: HSN
   * codes and tax treatment (`gst`), MRP and LASA handling (`pharmacy`), loose
   * versus packed selling units (`kirana`). Warehouse is the core product and is
   * on by default; the other three are off, because a field that is mandatory
   * for a pharmacy is noise for a distributor, and a validation rule nobody asked
   * for is a bug from the operator's side of the screen.
   *
   * Flags rather than a plan entitlement: these are how the organisation works,
   * not what it has paid for. Turning one off hides its navigation, its fields
   * and its validation — it does not delete the data already captured, so a pack
   * switched off and on again finds its rows intact.
   */
  packWarehouse: boolean("pack_warehouse").default(true).notNull(),
  packKirana: boolean("pack_kirana").default(false).notNull(),
  packPharmacy: boolean("pack_pharmacy").default(false).notNull(),
  packGst: boolean("pack_gst").default(false).notNull(),
  /**
   * B1 — the materials pack: construction and interior goods, dark stores with a
   * delivery zone, and the construction projects that consume them.
   *
   * Off by default like every other optional pack. Off means the catalogue
   * attributes are stripped from every response and refused on every write, the
   * project surfaces 404, and the dark-store fields on a warehouse are not
   * offered — a grade and a finish are the first two questions a tile buyer asks
   * and complete noise to a pharmacy.
   */
  packMaterials: boolean("pack_materials").default(false).notNull(),
  /**
   * NEO-2 — the quick-commerce pack: platform purchase orders, ASNs and
   * fill-rate. Off by default like every other optional pack, and off means the
   * ingest endpoint refuses before it parses anything.
   */
  packQuickCommerce: boolean("pack_quick_commerce").default(false).notNull(),
  /**
   * NEO-2 — Zepto's purchase orders arrive as email, not as an API call, so the
   * parser is heuristic in a way the JSON ones are not. It gets its own flag
   * because "we read a text file and believed it" is a decision an organisation
   * should make deliberately, not inherit from switching the pack on.
   */
  qcZeptoEmailPoEnabled: boolean("qc_zepto_email_po_enabled").default(false).notNull(),
  /**
   * NEO-2/NEO-12 — whether a delivery may be received without having been
   * announced. Off by default: most warehouses receive against a purchase order
   * and nothing else, and demanding an ASN they do not raise would stop
   * receiving altogether.
   */
  asnRequiredForGrn: boolean("asn_required_for_grn").default(false).notNull(),
  /**
   * NEO-14 - whether a newly reserved order may join a wave that is already open.
   *
   * Off by default, and that default is the safe one: a wave a picker is halfway
   * through is a physical walk they have planned, and adding a line to it behind
   * them is a change to work in progress. An organisation that wants order
   * streaming turns it on deliberately, having decided that a slightly longer
   * walk beats a second trip.
   */
  wavelessPicking: boolean("waveless_picking").default(false).notNull(),
  /**
   * The most lines a wave may reach by joining. A wave that grows without bound
   * is a picker who never finishes, which is the failure mode of every "just add
   * it to the current one" scheme.
   */
  wavelessMaxLines: integer("waveless_max_lines").default(50).notNull(),
  /**
   * D2 — short-dated stock is a different question from expired stock.
   *
   * `expiry_reservation_policy` decides whether an already-expired lot may be
   * promised at all. These two decide what happens to a lot that is still good
   * but close: `DEPRIORITIZE` keeps it allocatable and takes it last,
   * `BLOCK` refuses it automatically and leaves it for somebody holding
   * `inventory:allocation:override` to choose on purpose. The window is the same
   * one G3's expiry sweep notifies on, so "you were warned" and "the allocator
   * stopped offering it" line up instead of being two opinions about one lot.
   */
  nearExpiryPolicy: invNearExpiryPolicyEnum("near_expiry_policy").default("DEPRIORITIZE").notNull(),
  nearExpiryWindowDays: integer("near_expiry_window_days").default(30).notNull(),
  /**
   * E2 — how this organisation is registered, and therefore whether it may
   * collect tax from a customer at all.
   *
   * Lives beside the packs rather than on a document, because it is a property
   * of the registration and changes at most once or twice in a business's life.
   * Every outward line snapshots it anyway: a dealer that leaves the composition
   * scheme must not have last quarter's documents silently start claiming a tax
   * split they never showed.
   *
   * Only meaningful while `packGst` is on; an organisation not running the pack
   * keeps the default and nothing reads it.
   */
  gstMode: invGstModeEnum("gst_mode").default("REGULAR").notNull(),
  /**
   * E5 — the statutory adapters, each off until asked for.
   *
   * Separate from `packGst`, deliberately. The pack decides whether HSN codes
   * and tax treatment exist as *fields*; these decide whether this deployment
   * talks to an authority. An organisation capturing HSN for its own records and
   * filing through its accountant wants the first and not the second, and
   * collapsing them would sign it up for outbound traffic it never asked for.
   *
   * `*_ADAPTER` names which implementation answers. `stub` is the only one that
   * exists; anything else resolves to an adapter that refuses with
   * NO_CREDENTIALS rather than silently falling back, because a silent fallback
   * is how somebody comes to believe they are filing when they are rehearsing.
   */
  gstEinvoiceEnabled: boolean("gst_einvoice_enabled").default(false).notNull(),
  gstEwaybillEnabled: boolean("gst_ewaybill_enabled").default(false).notNull(),
  tallyExportEnabled: boolean("tally_export_enabled").default(false).notNull(),
  complianceAdapter: text("compliance_adapter").default("stub").notNull(),
  /**
   * E3 — the jurisdiction flag for the Schedule H1 register, default off.
   *
   * A bound H1 register is a legal obligation in some jurisdictions and not in
   * others, and it is not implied by running a pharmacy: a hospital store and a
   * retail chemist under the same roof answer to different rules. So it is its
   * own switch rather than something `packPharmacy` turns on, and it starts off
   * — a register that appears uninvited reads as a claim that this system keeps
   * one, which it does not.
   *
   * What it gates is an **export stub**. Inventory records stock movements, not
   * dispensings against a prescriber and a patient, so it cannot produce a
   * statutory register and does not pretend to: the export names the SKUs in
   * scope and states plainly that the dispensing rows are not held here. Turning
   * this on buys visibility of the scope, never compliance.
   */
  pharmacyH1RegisterEnabled: boolean("pharmacy_h1_register_enabled").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_settings_org_id").on(table.orgId, table.id),
  index("idx_inv_settings_org").on(table.orgId),
]);

/**
 * PEND-15. `inv_reason_codes` stood here and was dropped by `0589`.
 *
 * It arrived in 0407 to replace a fixed enum and nothing was ever built on it —
 * no service, no controller, no route, no foreign key. The only writer that ever
 * existed was 0407's own one-shot seed, so no organisation created since has had
 * a single row and none ever could; adjustments still record their reason as an
 * enum and a note. `inv_reason_category` is left in `common/enums-inventory.ts`
 * (re-exported from `enums.ts`) deliberately: dropping a type is a separate
 * hazard for one line of catalogue, and 0545's comment still names it.
 */

export const invNumberSequences = pgTable("inv_number_sequences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  docType: text("doc_type").notNull(),
  prefix: text("prefix").notNull(),
  nextNumber: integer("next_number").default(1).notNull(),
  padding: integer("padding").default(5).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_numseq_org_doctype").on(table.orgId, table.docType),
  unique("uniq_inv_number_sequences_org_id").on(table.orgId, table.id),
]);

export const invSettingsRelations = relations(invSettings, ({ one }) => ({
  organization: one(organizations, { fields: [invSettings.orgId], references: [organizations.id] }),
}));

export const invNumberSequencesRelations = relations(invNumberSequences, ({ one }) => ({
  organization: one(organizations, { fields: [invNumberSequences.orgId], references: [organizations.id] }),
}));
