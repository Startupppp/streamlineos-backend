/**
 * Inventory enums: what a SKU is and what the stock ledger holds.
 *
 * Product attributes and the tax/measure/ownership axes that qualify them, the
 * movement vocabulary (transaction type, quantity bucket, adjustment reason),
 * the lifecycles of the documents that post movements, the costing and expiry
 * policies that value them, and the verdicts recorded against insights derived
 * from all of it. Warehouse execution lives in `./enums-inventory-fulfilment`
 * and pack-gated verticals in `./enums-inventory-verticals`.
 *
 * Split out of `enums.ts` verbatim and re-exported from it, which stays the
 * import path every caller uses.
 */

import { pgEnum } from "drizzle-orm/pg-core";

export const invProductStatusEnum = pgEnum("inv_product_status", ["ACTIVE", "INACTIVE", "DISCONTINUED"]);
/**
 * D8. `SCRAP` names the condemning of goods that are on the shelf, which the
 * other seven reasons could only approximate: DAMAGE says why they are worthless
 * and RECOUNT says the count was wrong, but neither says the units were
 * destroyed. The ledger has had `SCRAP` as a transaction type since the first
 * migration and `inv_reason_category` has had it as a category; only the
 * document's own reason was missing it.
 */
export const invAdjReasonEnum = pgEnum("inv_adj_reason", ["PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER", "SCRAP"]);
/**
 * Which quantity a movement moved.
 *
 * Without it the ledger cannot say whether a row changed on-hand or moved
 * goods into a block or a quality hold, and quantity_before/quantity_after
 * describe a bucket the reader has to infer from transaction_type.
 */
export const invQuantityBucketEnum = pgEnum("inv_quantity_bucket", ["ON_HAND", "BLOCKED", "QUALITY_HOLD"]);

export const invTxnTypeEnum = pgEnum("inv_txn_type", ["PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN_IN", "RETURN_OUT", "GRN", "OPENING_BALANCE", "VENDOR_RETURN", "CUSTOMER_RETURN", "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS", "SCRAP", "QUARANTINE_IN", "QUARANTINE_OUT", "RESERVATION_CREATE", "RESERVATION_RELEASE", "RESERVATION_CONSUME",
  // NEO-9. Assembly is two halves of one act: components leave, a kit arrives.
  // Their own types rather than ADJUSTMENT_IN/OUT, because an adjustment means
  // "the count was wrong" and this means "we built something" - and a warehouse
  // reading its own movement report should be able to tell those apart.
  "KIT_ASSEMBLE_IN", "KIT_ASSEMBLE_OUT", "KIT_DISASSEMBLE_IN", "KIT_DISASSEMBLE_OUT"]);
export const invPoStatusEnum = pgEnum("inv_po_status", ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]);
export const invSoStatusEnum = pgEnum("inv_so_status", ["DRAFT", "CONFIRMED", "PARTIALLY_RESERVED", "RESERVED", "PICKED", "PACKED", "SHIPPED", "PARTIALLY_SHIPPED", "INVOICED", "CANCELLED", "CLOSED"]);
export const invTransferStatusEnum = pgEnum("inv_transfer_status", ["PENDING", "RESERVED", "IN_TRANSIT", "COMPLETED", "CANCELLED"]);
export const invLocationTypeEnum = pgEnum("inv_location_type", ["ZONE", "AISLE", "RACK", "BIN", "RECEIVING", "SHIPPING", "QUARANTINE", "SCRAP", "TRANSIT", "RETURNS"]);
export const invGrnQualityEnum = pgEnum("inv_grn_quality", ["ACCEPTED", "REJECTED"]);
/**
 * B1. A delivery has a life before it becomes stock.
 *
 * `inv_grns` had no status at all, so recording a receipt and posting it were
 * the same act and there was nowhere to put a delivery that had arrived but not
 * yet been counted. DRAFT and COUNTING write no stock; QUALITY_REVIEW is the
 * step where an inspector looks at what the counter found; POSTED is the only
 * state in which `inv_stock_transactions` has rows for this document. CANCELLED
 * is how an unposted receipt is abandoned — the row stays, because a delivery
 * somebody walked away from is a fact worth keeping.
 */
export const invGrnStatusEnum = pgEnum("inv_grn_status", [
  "DRAFT",
  "COUNTING",
  "QUALITY_REVIEW",
  "POSTED",
  "CANCELLED",
]);
/** INV-201. Why a received line did not match what the purchase order owed. */
export const invGrnDiscrepancyEnum = pgEnum("inv_grn_discrepancy", [
  "SHORT",
  "OVER",
  "DAMAGED",
  "WRONG_ITEM",
]);
export const invAdjustmentStatusEnum = pgEnum("inv_adjustment_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PENDING_POST", "POSTED", "CANCELLED"]);
/**
 * B9. `APPROVED` sits between the draft and the ledger.
 *
 * A return used to go from DRAFT straight to POSTED, so the act of moving stock
 * and the act of agreeing to move it were the same click. The inspection
 * recorded by INV-209 had nobody signing it off, and a cancellation had exactly
 * one moment it could happen in.
 */
export const invReturnStatusEnum = pgEnum("inv_return_status", ["DRAFT", "APPROVED", "POSTED", "CANCELLED"]);

/**
 * E2 — how a supply is treated for GST, which is not the same question as what
 * rate it carries.
 *
 * `TAXABLE` at 0% and `NIL_RATED` look identical on an invoice line and are
 * different rows in a GSTR-1 summary; `EXEMPT` and `NON_GST` differ again in
 * whether input credit has to be reversed. Collapsing them into "rate = 0"
 * loses the distinction the return actually asks for, so the treatment is
 * stored beside the rate rather than derived from it.
 */
export const invTaxTreatmentEnum = pgEnum("inv_tax_treatment", [
  "TAXABLE", "EXEMPT", "NIL_RATED", "ZERO_RATED", "NON_GST",
]);

/**
 * E2 — the organisation's GST registration mode.
 *
 * A composition dealer pays tax out of turnover and may not collect it from a
 * customer, so an outward document that shows a tax split is not merely
 * cosmetic — it is an invoice the dealer is not allowed to raise. The mode is
 * snapshotted onto every document line so a later switch cannot rewrite what an
 * already-posted document claimed.
 */
export const invGstModeEnum = pgEnum("inv_gst_mode", ["REGULAR", "COMPOSITION"]);

/**
 * E4 — whether a SKU leaves the shop as a sealed pack or is measured out of one.
 *
 * A packed SKU is handed over in the unit it was received in. A loose SKU is
 * broken out of bulk: rice received in 25 kg sacks and sold in 500 g scoops is
 * one product, one stock balance, and two units of measure with a conversion
 * between them. The distinction is what decides whether a sale may name a
 * different unit from the stock the ledger holds — not a cosmetic label.
 */
export const invSaleModeEnum = pgEnum("inv_sale_mode", ["PACKED", "LOOSE"]);

/**
 * E4 — how a quantity may be entered for this SKU.
 *
 * `WHOLE` is countable goods: three tins, not 3.25 tins. `DECIMAL` is a measure
 * somebody types. `SCALE` is a measure a weighing scale sends, which differs
 * from `DECIMAL` in exactly one way that matters — the operator did not choose
 * the digits, so the number arrives at the scale's own precision and must not be
 * silently re-rounded to something tidier on the way in.
 *
 * All three describe *entry*. The ledger stores base units at scale 4 whichever
 * one is set; this decides what is allowed to reach it, not what it holds.
 */
export const invQtyInputModeEnum = pgEnum("inv_qty_input_mode", ["WHOLE", "DECIMAL", "SCALE"]);

export const invProductTypeEnum = pgEnum("inv_product_type", ["STOCKABLE", "CONSUMABLE", "SERVICE"]);
export const invTrackingMethodEnum = pgEnum("inv_tracking_method", ["NONE", "LOT", "SERIAL"]);

/**
 * NEO-10 - how a SKU's quantity is measured.
 *
 * `PIECES` is everything Streamline has held until now: a quantity is a count,
 * and 12 means twelve of them. `CATCH_WEIGHT` is the grocery and meat case: a
 * SKU is *sold* by weight and *handled* in pieces, and the two do not derive from
 * each other. Two bags of chicken are two bags and 10.35 kg, and the second bag
 * weighing 5.10 kg is not an error to be corrected - it is the fact the invoice
 * is raised on.
 *
 * The ledger holds the **weight** for a catch-weight SKU, because that is the
 * number that has to add up across receipts and issues. The piece count rides
 * alongside on the document, for the person counting the bags.
 */
export const invMeasureModeEnum = pgEnum("inv_measure_mode", ["PIECES", "CATCH_WEIGHT"]);

/**
 * NEO-11 - whose stock this is.
 *
 * `OWNED` is ours and is the default and the overwhelming majority. `VENDOR` is
 * consignment: it is standing in our building and it belongs to a supplier until
 * it is sold, so it is not available to promise and not in our valuation.
 * `CUSTOMER` is the mirror - a customer's goods we are holding or working on.
 *
 * Part of a stock level's natural key, so a consigned pallet and an owned one at
 * the same bin are two rows and stay tellable apart. Carrying it as a flag on the
 * product instead would make it impossible to hold both, which every
 * consignment arrangement eventually requires.
 */
export const invOwnershipEnum = pgEnum("inv_ownership", ["OWNED", "VENDOR", "CUSTOMER"]);
export const invCostingMethodEnum = pgEnum("inv_costing_method", ["STANDARD", "WEIGHTED_AVERAGE", "FIFO"]);
export const invReservationStatusEnum = pgEnum("inv_reservation_status", ["ACTIVE", "CONSUMED", "RELEASED", "EXPIRED"]);
export const invLotStatusEnum = pgEnum("inv_lot_status", ["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]);
export const invSerialStatusEnum = pgEnum("inv_serial_status", ["IN_STOCK", "RESERVED", "SHIPPED", "RETURNED", "SCRAPPED", "QUARANTINE"]);
export const invBarcodeTypeEnum = pgEnum("inv_barcode_type", ["GTIN", "EAN13", "UPC", "CODE128", "QR", "OTHER"]);
export const invReasonCategoryEnum = pgEnum("inv_reason_category", ["ADJUSTMENT", "COUNT", "SCRAP", "RETURN", "TRANSFER", "OTHER"]);
export const invVendorReturnReasonEnum = pgEnum("inv_vendor_return_reason", ["DAMAGED", "WRONG_ITEM", "EXCESS", "EXPIRED", "QUALITY_REJECTED"]);
/**
 * B9. `RETURN_TO_VENDOR` is the fourth answer an inspector can give.
 *
 * The goods are faulty but they are the supplier's fault, so they arrive, they
 * are not sellable, and they are not written off either — they wait for a vendor
 * RMA to take them away. Modelled as `BLOCKED` stock rather than a status flag:
 * they are physically on the shelf, and availability already subtracts
 * `blocked_qty`.
 */
export const invCustomerReturnDispositionEnum = pgEnum("inv_customer_return_disposition", ["RESTOCK", "QUARANTINE", "SCRAP", "RETURN_TO_VENDOR"]);

export const invReservationStrategyEnum = pgEnum("inv_reservation_strategy", ["MANUAL", "AUTO_ON_CONFIRM", "FEFO", "FIFO"]);
export const invExpiryPolicyEnum = pgEnum("inv_expiry_policy", ["BLOCK", "WARN", "ALLOW"]);
/**
 * D2 — what the allocator does with stock that is close to expiry but not expired.
 *
 * Distinct from `invExpiryPolicyEnum`, which decides whether *already expired*
 * stock may be promised at all. This one is about short-dated stock: physically
 * fine, saleable, and often refused on arrival by the customer. `DEPRIORITIZE`
 * keeps it allocatable but takes it last; `BLOCK` refuses it automatically and
 * leaves it for a person holding `inventory:allocation:override` to choose
 * deliberately.
 */
export const invNearExpiryPolicyEnum = pgEnum("inv_near_expiry_policy", ["ALLOW", "DEPRIORITIZE", "BLOCK"]);
/**
 * G5 — a landed-cost voucher has two states and no third.
 *
 * DRAFT is editable and has moved no money; APPLIED has revalued cost layers and
 * posted a journal entry, and is terminal. There is deliberately no VOID: undoing
 * an applied voucher means un-revaluing layers that a later issue may already
 * have drawn from at the landed rate, and that reversal is a document of its own
 * rather than a status flip.
 */
export const invLandedCostStatusEnum = pgEnum("inv_landed_cost_status", ["DRAFT", "APPLIED"]);
/** How a charge is spread across the receipt's cost layers. */
export const invLandedCostBasisEnum = pgEnum("inv_landed_cost_basis", ["VALUE", "QUANTITY"]);
export const invLandedCostChargeTypeEnum = pgEnum("inv_landed_cost_charge_type", [
  "FREIGHT",
  "DUTY",
  "INSURANCE",
  "HANDLING",
  "OTHER",
]);
export const invAiInsightStatusEnum = pgEnum("inv_ai_insight_status", ["NEW", "ACKNOWLEDGED", "DISMISSED"]);

/**
 * F6 — what a person says about an AI answer they were shown.
 *
 * Four verdicts rather than a thumb, because the four are acted on differently
 * and collapsing them destroys the only signal worth having. `WRONG` is a claim
 * about the arithmetic and points at the deterministic layer. `STALE` says the
 * numbers were right when computed and are not any more, which is a caching and
 * evidence-hash question, not a model question. `UNSAFE` is the one that must
 * never be averaged into a satisfaction ratio: it means the answer proposed
 * something an operator should not do, and one of those matters more than a
 * hundred `USEFUL`s.
 *
 * A pg enum rather than free text so an unknown verdict cannot be stored at all
 * — a text column with an application-side union drifts the first time a client
 * sends something else.
 */
export const invAiFeedbackVerdictEnum = pgEnum("inv_ai_feedback_verdict", [
  "USEFUL",
  "WRONG",
  "STALE",
  "UNSAFE",
]);
