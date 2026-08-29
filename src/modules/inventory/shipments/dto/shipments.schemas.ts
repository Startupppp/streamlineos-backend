import { z } from "zod";

export const createCarrierSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  trackingUrlTemplate: z.string().optional(),
  isActive: z.boolean().optional().default(true),
}).strict();
export type CreateCarrierInput = z.infer<typeof createCarrierSchema>;

export const updateCarrierSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  trackingUrlTemplate: z.string().optional(),
  isActive: z.boolean().optional(),
}).strict();
export type UpdateCarrierInput = z.infer<typeof updateCarrierSchema>;

export const listPackagesQuerySchema = z.object({
  shipmentId: z.coerce.number().int().optional(),
  status: z.enum(["OPEN", "CLOSED", "SHIPPED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListPackagesQueryInput = z.infer<typeof listPackagesQuerySchema>;

export const createPackageSchema = z.object({
  shipmentId: z.number().int().optional(),
  /** B6. Which order's goods go in the carton; a shipment does not exist yet. */
  soId: z.number().int().positive().optional(),
  cartonTypeId: z.number().int().positive().optional(),
  weight: z.string().optional(),
  dimensionsL: z.string().optional(),
  dimensionsW: z.string().optional(),
  dimensionsH: z.string().optional(),
  lines: z.array(z.object({
    productVariantId: z.number().int(),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/),
  }).strict()).optional().default([]),
}).strict();
export type CreatePackageInput = z.infer<typeof createPackageSchema>;

/**
 * B6 — one scan at the packing bench.
 *
 * `scannedPayload` is the raw thing the wedge read, resolved the way picking
 * resolves it; `productVariantId` is the keyboard fallback for a label that will
 * not read. One or the other, never neither — a scan endpoint that accepts an
 * empty body is a button that adds a unit nobody scanned.
 */
export const scanIntoPackageSchema = z.object({
  scannedPayload: z.string().min(1).max(500).optional(),
  productVariantId: z.number().int().positive().optional(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/).optional().default("1"),
}).strict().refine(
  (v) => v.scannedPayload !== undefined || v.productVariantId !== undefined,
  { message: "Provide a scannedPayload or a productVariantId" },
);
export type ScanIntoPackageInput = z.infer<typeof scanIntoPackageSchema>;

/**
 * The carton is named at close rather than at create because the packer knows
 * which box the goods went into only once they are in it. Recorded on the
 * package so a closed parcel can be re-checked, and refused when the contents
 * demonstrably do not fit.
 */
export const closePackageSchema = z.object({
  cartonTypeId: z.number().int().positive().optional(),
}).strict().optional().default({});
export type ClosePackageInput = z.infer<typeof closePackageSchema>;

export const packingQueueQuerySchema = z.object({
  warehouseId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type PackingQueueQueryInput = z.infer<typeof packingQueueQuerySchema>;

export const updatePackageLinesSchema = z.object({
  lines: z.array(z.object({
    productVariantId: z.number().int(),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/),
  }).strict()).min(1),
}).strict();
export type UpdatePackageLinesInput = z.infer<typeof updatePackageLinesSchema>;

export const listShipmentsQuerySchema = z.object({
  status: z.enum(["DRAFT", "PACKED", "LABEL_CREATED", "SHIPPED", "DELIVERED", "CANCELLED"]).optional(),
  carrierId: z.coerce.number().int().optional(),
  warehouseId: z.coerce.number().int().optional(),
  soId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListShipmentsQueryInput = z.infer<typeof listShipmentsQuerySchema>;

export const createShipmentSchema = z.object({
  soId: z.number().int().optional(),
  warehouseId: z.number().int().optional(),
  carrierId: z.number().int().optional(),
  trackingNumber: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    soLineId: z.number().int().optional(),
    productVariantId: z.number().int(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/),
    lotId: z.number().int().optional(),
    serialId: z.number().int().optional(),
  }).strict()).optional().default([]),
}).strict();
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

export const updateShipmentSchema = z.object({
  carrierId: z.number().int().optional(),
  trackingNumber: z.string().optional(),
  notes: z.string().optional(),
  warehouseId: z.number().int().optional(),
}).strict();
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

export const shipActionSchema = z.object({
  trackingNumber: z.string().optional(),
  carrierId: z.number().int().optional(),
}).strict().optional().default({});
export type ShipActionInput = z.infer<typeof shipActionSchema>;

export const listLoadsQuerySchema = z.object({
  status: z.enum(["DRAFT", "DISPATCHED", "ARRIVED", "CLOSED", "CANCELLED"]).optional(),
  carrierId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListLoadsQueryInput = z.infer<typeof listLoadsQuerySchema>;

export const createLoadSchema = z.object({
  sourceWarehouseId: z.number().int().optional(),
  destination: z.string().optional(),
  carrierId: z.number().int().optional(),
  vehicleRef: z.string().optional(),
  shipmentIds: z.array(z.number().int()).optional().default([]),
  transferIds: z.array(z.number().int()).optional().default([]),
}).strict();
export type CreateLoadInput = z.infer<typeof createLoadSchema>;

export const dispatchLoadSchema = z.object({ dispatchDate: z.string().optional() }).strict();
export type DispatchLoadInput = z.infer<typeof dispatchLoadSchema>;

export const closeLoadSchema = z.object({ arrivalDate: z.string().optional() }).strict();
export type CloseLoadInput = z.infer<typeof closeLoadSchema>;
