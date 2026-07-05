export const INV_ERRORS = {
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
  INVALID_DOCUMENT_STATE: "INVALID_DOCUMENT_STATE",
  LOT_EXPIRED: "LOT_EXPIRED",
  SERIAL_ALREADY_USED: "SERIAL_ALREADY_USED",
  QUALITY_HOLD: "QUALITY_HOLD",
  COSTING_METHOD_LOCKED: "COSTING_METHOD_LOCKED",
  INVENTORY_MODULE_DISABLED: "INVENTORY_MODULE_DISABLED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  WAREHOUSE_NOT_FOUND: "WAREHOUSE_NOT_FOUND",
  LOCATION_NOT_FOUND: "LOCATION_NOT_FOUND",
  STOCK_RESERVED: "STOCK_RESERVED",
  PACKAGE_CONTENT_MISMATCH: "PACKAGE_CONTENT_MISMATCH",
  CHANNEL_SYNC_FAILED: "CHANNEL_SYNC_FAILED",
} as const;

export type InvErrorCode = (typeof INV_ERRORS)[keyof typeof INV_ERRORS];

export type QualityBucket = "ON_HAND" | "BLOCKED" | "QUALITY_HOLD";

export interface StockMovement {
  transactionType: string;
  productVariantId: number;
  locationId: number;
  lotId?: number;
  serialId?: number;
  quantityDelta: string;
  unitCost?: string;
  qualityBucket?: QualityBucket;
}

export interface StockEngineCommand {
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  reason?: string;
  movements: StockMovement[];
}

export interface StockLevelSnapshot {
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
}
