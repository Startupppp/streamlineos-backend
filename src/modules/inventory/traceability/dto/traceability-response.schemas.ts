import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const lotListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string().optional(),
  productVariantId: z.number().int(),
  lotNumber: z.string(),
  manufactureDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  supplierLotNumber: z.string().nullable(),
  status: z.string(),
  qualityStatus: z.string().nullable(),
  createdAt: wireDate(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  productSku: z.string(),
  totalOnHand: z.string(),
});

export const listLotsResponseSchema = itemsPagedSchema(lotListItemSchema);

const serialListItemSchema = z.object({
  id: z.number().int(),
  serialNumber: z.string(),
  lotId: z.number().int().nullable(),
  status: z.string(),
  currentLocationId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  createdAt: wireDate(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  currentLocationName: z.string().nullable(),
  currentLocationCode: z.string().nullable(),
});

export const listSerialsResponseSchema = itemsPagedSchema(serialListItemSchema);

export const updateLotStatusResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  lotNumber: z.string(),
  manufactureDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  supplierLotNumber: z.string().nullable(),
  status: z.string(),
  qualityStatus: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const getLotDetailResponseSchema = z.object({
  lot: z.record(z.string(), z.unknown()),
  stockByLocation: z.array(z.object({
    locationId: z.number().int(),
    locationName: z.string(),
    locationCode: z.string(),
    warehouseId: z.number().int(),
    warehouseName: z.string(),
    onHand: z.string(),
    committed: z.string(),
    blockedQty: z.string().nullable(),
  })),
  movements: z.array(z.record(z.string(), z.unknown())),
});

export const getSerialDetailResponseSchema = z.object({
  serial: z.record(z.string(), z.unknown()),
  movements: z.array(z.record(z.string(), z.unknown())),
});

export const expiryReportResponseSchema = z.array(z.object({
  id: z.number().int(),
  lotNumber: z.string(),
  expiryDate: z.string().nullable(),
  status: z.string(),
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  totalOnHand: z.string(),
  daysUntilExpiry: z.number().int(),
}));

export const traceabilityChainResponseSchema = z.object({
  origin: z.record(z.string(), z.unknown()).nullable(),
  receipts: z.array(z.record(z.string(), z.unknown())),
  currentStock: z.array(z.record(z.string(), z.unknown())),
  shipments: z.array(z.record(z.string(), z.unknown())),
  vendorReturns: z.array(z.record(z.string(), z.unknown())),
  customerReturns: z.array(z.record(z.string(), z.unknown())),
  events: z.array(z.record(z.string(), z.unknown())),
});
