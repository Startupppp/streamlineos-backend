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
  qty: string;
  expiresAt?: Date;
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
}

/** E1 — the four packs. Warehouse is the core product; the rest are opt-in. */
export interface InvPackFlags {
  warehouse: boolean;
  kirana: boolean;
  pharmacy: boolean;
  gst: boolean;
}
