export const INV_ERRORS = {
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
  INVALID_DOCUMENT_STATE: "INVALID_DOCUMENT_STATE",
  LOT_EXPIRED: "LOT_EXPIRED",
  SERIAL_ALREADY_USED: "SERIAL_ALREADY_USED",
  QUALITY_HOLD: "QUALITY_HOLD",
  HOLD_EXCEEDS_ON_HAND: "HOLD_EXCEEDS_ON_HAND",
  LOCATION_CAPACITY_EXCEEDED: "LOCATION_CAPACITY_EXCEEDED",
  RELEASE_EXCEEDS_HELD: "RELEASE_EXCEEDS_HELD",
  COSTING_METHOD_LOCKED: "COSTING_METHOD_LOCKED",
  INVENTORY_MODULE_DISABLED: "INVENTORY_MODULE_DISABLED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  WAREHOUSE_NOT_FOUND: "WAREHOUSE_NOT_FOUND",
  LOCATION_NOT_FOUND: "LOCATION_NOT_FOUND",
  STOCK_RESERVED: "STOCK_RESERVED",
  PACKAGE_CONTENT_MISMATCH: "PACKAGE_CONTENT_MISMATCH",
  CHANNEL_SYNC_FAILED: "CHANNEL_SYNC_FAILED",
} as const;

type QualityBucket = "ON_HAND" | "BLOCKED" | "QUALITY_HOLD";

export interface StockMovement {
  transactionType: string;
  productVariantId: number;
  locationId: number;
  lotId?: number;
  serialId?: number;
  /**
   * NEO-4 - the handling unit this movement is against, or absent for loose
   * stock in the bin. Part of the level's natural key, so a receipt into a
   * pallet and a receipt onto the shelf beside it land on different rows.
   */
  handlingUnitId?: number | null;
  /**
   * NEO-11 - whose stock this movement is against. Absent means `OWNED`, which
   * is what every movement in the product was before consignment existed.
   */
  ownership?: "OWNED" | "VENDOR" | "CUSTOMER";
  quantityDelta: string;
  unitCost?: string;
  qualityBucket?: QualityBucket;
  /**
   * A2. The posted movement this one compensates. Set by `reverseInTx`; a
   * correction is the only legitimate way to change what the ledger says, and
   * the link is what makes the pair legible afterwards.
   */
  correctionOfTransactionId?: number;
  /**
   * A2. The cost side is already settled by the caller: record this cost on the
   * row and consume no layers.
   *
   * Set when reversing a receipt. `reverseReceiptLayer` has already unwound the
   * layer that receipt created, so letting the compensating movement take the
   * ordinary issue path made it consume layers a second time — either failing
   * outright ("cost layers do not cover this issue") when the reversed receipt
   * was the only coverage, or, worse, quietly consuming unrelated older layers
   * and removing the same value from inventory twice.
   */
  settledCost?: { unitCost: string | null; totalCost: string | null };
  /**
   * A2. Take this receipt's cost basis from what an earlier movement in the
   * same command actually turned out to cost, by index into `movements`.
   *
   * A transfer's transit leg is the case: the goods are received into transit
   * at exactly what leaving the source consumed, and that figure is not known
   * until the outbound issue has drawn its layers. Estimating it instead —
   * average cost, or the oldest open layer — is exact under weighted average
   * and wrong under FIFO the moment an issue crosses a layer boundary, which
   * understates inventory for the length of the journey.
   *
   * Only a backward reference is legal: a movement cannot inherit from one that
   * has not been costed yet.
   */
  costFromMovementIndex?: number;
}

export interface StockEngineCommand {
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  reason?: string;
  /** Business date the movement belongs to (YYYY-MM-DD). Defaults to today. */
  postingDate?: string;
  movements: StockMovement[];
}

interface StockLevelSnapshot {
  productVariantId: number;
  locationId: number;
  onHand: string;
}

export interface StockEngineResult {
  transactionIds: number[];
  levels: StockLevelSnapshot[];
}

export interface ReverseCommand {
  idempotencyKey: string;
  stockTransactionId: number;
  reason: string;
}

export interface ReservationInput {
  sourceType: string;
  sourceId: string;
  sourceLineId?: string;
  productVariantId: number;
  warehouseId?: number;
  locationId?: number;
  lotId?: number;
  serialId?: number;
  /** NEO-4 - the handling unit the promise is against. See `reservations.ts`. */
  handlingUnitId?: number | null;
  /**
   * NEO-11. A promise is always against owned stock: `availableQty` returns zero
   * for anything else, so a consigned reservation would be refused anyway. The
   * field exists so a caller cannot silently reserve the owned row when it meant
   * the consigned one.
   */
  ownership?: "OWNED" | "VENDOR" | "CUSTOMER";
  qty: string;
  expiresAt?: Date;
  /**
   * NEO-1 — the sales channel this promise is being made for, or null/absent for
   * a direct sale.
   *
   * It is what the channel-pool gate is checked against: a promise that names a
   * channel may draw on that channel's own claim, and one that does not may draw
   * on none of them. Absent is the safe default — a caller that forgets it gets
   * the direct-sale answer, which refuses more, never less.
   */
  channelId?: number | null;
}

export interface InvSettingsRow {
  allowNegativeStock: boolean;
  allowBackorders: boolean;
  reservationStrategy: string;
  defaultCostingMethod: string;
  expiryReservationPolicy: string;
  inspectionOnReceipt: boolean;
  inspectionOnReturn: boolean;
  overReceiptTolerancePct: string;
  requirePoApproval: boolean;
  adjustmentApprovalThreshold: string | null;
  autoReserveOnConfirm: boolean;
  allowPartialShipment: boolean;
  packageRequiredForShipping: boolean;
  channelPublishPolicy: string | null;
  /**
   * E1. Which packs this organisation runs. Carried on the row every engine and
   * service already reads, so a pack check never needs a second query — and a
   * rule that must not fire when its pack is off cannot forget to look.
   */
  packs: InvPackFlags;
  /**
   * E2. How the organisation is registered. Only meaningful while the `gst` pack
   * is on; carried on the same row so the composition rule never needs a second
   * query at the moment a document line is priced.
   */
  gstMode: InvGstMode;
  /** D2. What the allocator does with short-dated stock, and where "short" starts. */
  nearExpiryPolicy: InvNearExpiryPolicy;
  nearExpiryWindowDays: number;
  /** E5. Statutory adapters, each off until asked for. See `india-compliance-adapter.ts`. */
  gstEinvoiceEnabled: boolean;
  gstEwaybillEnabled: boolean;
  tallyExportEnabled: boolean;
  complianceAdapter: string;
  /**
   * E3. Whether this deployment produces the Schedule H1 register export. Its
   * own switch, not something the `pharmacy` pack implies — see the column
   * comment on `inv_settings.pharmacy_h1_register_enabled`.
   */
  pharmacyH1RegisterEnabled: boolean;
  /**
   * NEO-2. Zepto's purchase orders arrive as email, so the parser is heuristic
   * where the JSON ones are not. Its own switch, not implied by the pack.
   */
  qcZeptoEmailPoEnabled: boolean;
  /**
   * NEO-2/NEO-12. Whether a delivery may be received without having been
   * announced. Off by default: most warehouses receive against a purchase order
   * and nothing else.
   */
  asnRequiredForGrn: boolean;
}

/** D2 — short-dated, not expired. See `invNearExpiryPolicyEnum`. */
export type InvNearExpiryPolicy = "ALLOW" | "DEPRIORITIZE" | "BLOCK";


/** E1 — the four packs. Warehouse is the core product; the rest are opt-in. */
export interface InvPackFlags {
  warehouse: boolean;
  kirana: boolean;
  pharmacy: boolean;
  /**
   * NEO-2. Platform purchase orders, ASNs and fill-rate. Off by default like the
   * other optional packs; off means the ingest endpoint refuses before parsing.
   */
  quickCommerce: boolean;
  gst: boolean;
}

/** E2 — GST registration mode. A composition dealer may not collect outward tax. */
export type InvGstMode = "REGULAR" | "COMPOSITION";

/**
 * E2 — how a supply is treated for GST, which is a different question from what
 * rate it carries: `TAXABLE` at 0% and `NIL_RATED` are separate lines in a
 * return.
 */
export type InvTaxTreatment = "TAXABLE" | "EXEMPT" | "NIL_RATED" | "ZERO_RATED" | "NON_GST";
