import { positiveDecimalQuantity } from "../../stock-engine/dto/quantity.schemas";
import { z } from "zod";

export const listPoSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]).optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListPoInput = z.infer<typeof listPoSchema>;

const poLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  /** In `uomId` when one is given, otherwise in the product's base unit. */
  quantity: z.number().positive(),
  /**
   * The unit the buyer typed in. The server resolves the factor and computes the
   * base quantity — a client-supplied factor would let the caller decide how
   * many units a case holds.
   */
  uomId: z.number().int().positive().optional(),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  lineOrder: z.number().int().min(0).default(0),
}).strict();

export const createPoSchema = z.object({
  vendorId: z.number().int().positive(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).default("INR"),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1),
}).strict();
export type CreatePoInput = z.infer<typeof createPoSchema>;

export const updatePoSchema = z.object({
  vendorId: z.number().int().positive().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1).optional(),
}).strict();
export type UpdatePoInput = z.infer<typeof updatePoSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const grnLotLineSchema = z.object({
  poLineId: z.number().int().positive(),
  /**
   * INV-201. A decimal string, not a number. This quantity becomes a stock
   * ledger row, and it was reaching the engine as `Number(...).toFixed(4)` --
   * float arithmetic on the one value the inventory PRD forbids it for.
   *
   * B1. In `uomId` when one is given, otherwise in the product's base unit --
   * the same contract `poLineSchema.quantity` has. The base quantity and the
   * factor are derived on the server; a client-supplied factor would let the
   * caller decide how many units a case holds.
   */
  quantityReceived: positiveDecimalQuantity,
  uomId: z.number().int().positive().optional(),
  /**
   * Why the line did not match what the purchase order still owed. Optional:
   * a routine partial delivery is not an exception and should not demand
   * paperwork, and the expected quantity is snapshotted either way.
   */
  discrepancyReason: z.enum(["SHORT", "OVER", "DAMAGED", "WRONG_ITEM"]).optional(),
  qualityStatus: z.enum(["ACCEPTED", "REJECTED"]).default("ACCEPTED"),
  rejectionReason: z.string().max(500).optional(),
  /**
   * NEO-4 - the handling unit this line was counted onto. Optional: most
   * receipts are loose into a bin, and demanding a pallet for those would be a
   * form field with no purpose.
   */
  handlingUnitId: z.number().int().positive().optional(),
  /**
   * NEO-8 - the outbound sales order these units are for. Set it and the line is
   * cross-docked: received at the dock and moved straight to outbound staging,
   * never reaching a storage bin and never raising a putaway task.
   */
  crossDockSoId: z.number().int().positive().optional(),
  /**
   * NEO-10 - how many pieces this line's weight came in. Required for a
   * catch-weight SKU, refused for one counted in pieces; the rule is applied by
   * `assertCatchWeightLine` where the product's measure mode is known.
   */
  quantityPieces: positiveDecimalQuantity.optional(),
  /**
   * NEO-11 - receive as consignment. Absent means owned, which is what every
   * receipt in the product was before consignment existed; `.optional()` rather
   * than `.default()` deliberately, so the *input* type stays optional and no
   * existing caller has to be edited to say what it already meant.
   */
  ownership: z.enum(["OWNED", "VENDOR", "CUSTOMER"]).optional(),
  lotNumber: z.string().max(100).optional(),
  expiryDate: isoDate.optional(),
  manufactureDate: isoDate.optional(),
  /**
   * E3 — the two prices a pharmacy receipt captures, in integer paise.
   *
   * `mrpPaise` is what was printed on the cartons that arrived; the post
   * transaction carries it onto `inv_lots.mrp_paise`, which is what a dispense
   * reads. `purchaseRatePaise` is what this delivery actually cost per unit,
   * which is routinely not what the order said.
   *
   * Optional here and required by the pharmacy pack, not by the schema: a
   * distributor's receipt form has neither field, and a validation rule nobody
   * asked for reads as a bug. `InvPharmacyService.assertReceiptLine` is what
   * refuses a flagged SKU without an MRP, and only while the pack is on.
   */
  mrpPaise: z.number().int().positive().max(1_000_000_000, "MRP is in paise, not rupees").optional(),
  purchaseRatePaise: z.number().int().positive().max(1_000_000_000, "the purchase rate is in paise, not rupees").optional(),
  serialNumbers: z.array(z.string().max(100)).optional(),
}).strict();

export const createGrnSchema = z.object({
  receivedDate: isoDate,
  locationId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  /** NEO-2 — the ASN this delivery fulfils. See `createGrnDraftSchema`. */
  asnId: z.number().int().positive().optional(),
  lines: z.array(grnLotLineSchema).min(1),
}).strict();
export type CreateGrnInput = z.infer<typeof createGrnSchema>;

/**
 * B1. Opening a receipt without posting it.
 *
 * The purchase order arrives in the body rather than the path because the
 * document being created is the receipt, and everything that happens to it
 * afterwards is addressed as `/inventory/goods-receipts/:grnId`.
 */
export const createGrnDraftSchema = z.object({
  poId: z.number().int().positive(),
  receivedDate: isoDate,
  locationId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  /**
   * NEO-2 — the advance shipping notice this delivery fulfils, when there is
   * one. Optional even where `asn_required_for_grn` is on: the rule then accepts
   * any open ASN for the purchase order, because a driver arriving with a
   * paper docket knows the PO and not our ASN number.
   */
  asnId: z.number().int().positive().optional(),
  lines: z.array(grnLotLineSchema).min(1),
}).strict();
export type CreateGrnDraftInput = z.infer<typeof createGrnDraftSchema>;

/**
 * Counting a delivery is editing it. `lines`, when present, replaces the whole
 * set -- a partial merge would need a stable line identity the counter does not
 * have in front of them, and "these are the lines" is what a recount means.
 */
export const updateGrnDraftSchema = z.object({
  receivedDate: isoDate.optional(),
  locationId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(grnLotLineSchema).min(1).optional(),
}).strict();
export type UpdateGrnDraftInput = z.infer<typeof updateGrnDraftSchema>;

export const cancelGrnSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type CancelGrnInput = z.infer<typeof cancelGrnSchema>;

export const listGrnSchema = z.object({
  poId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  status: z.enum(["DRAFT", "COUNTING", "QUALITY_REVIEW", "POSTED", "CANCELLED"]).optional(),
  /**
   * One site's receipts.
   *
   * `inv_grns` carries a `location_id` and no warehouse column, so this is
   * resolved through `inv_locations` — the same resolution the warehouse scope
   * already performs on this table, rather than a second answer to "which
   * warehouse is this receipt in". A receipt posted to no location belongs to no
   * warehouse and so matches no filter.
   */
  warehouseId: z.coerce.number().int().positive().optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListGrnInput = z.infer<typeof listGrnSchema>;

export const reverseGrnSchema = z.object({
  reason: z.string().max(500),
}).strict();
export type ReverseGrnInput = z.infer<typeof reverseGrnSchema>;
