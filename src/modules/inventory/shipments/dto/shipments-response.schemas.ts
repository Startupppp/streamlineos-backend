import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

export const invCarrierSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  code: z.string(),
  trackingUrlTemplate: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCarriersResponseSchema = z.array(invCarrierSchema);

const shipmentLineSchema = z.object({
  id: z.number().int(),
  shipmentId: z.number().int(),
  soLineId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  quantity: z.string(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
});

const packageLineSchema = z.object({
  id: z.number().int(),
  packageId: z.number().int(),
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
});

export const invShipmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  shipmentNumber: z.string(),
  soId: z.number().int().nullable(),
  warehouseId: z.number().int().nullable(),
  carrierId: z.number().int().nullable(),
  trackingNumber: z.string().nullable(),
  status: z.string(),
  shippedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listShipmentsResponseSchema = itemsPagedSchema(invShipmentSchema);

export const invPackageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  packageNumber: z.string(),
  shipmentId: z.number().int().nullable(),
  weight: z.string().nullable(),
  dimensionsL: z.string().nullable(),
  dimensionsW: z.string().nullable(),
  dimensionsH: z.string().nullable(),
  status: z.string().optional(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(packageLineSchema).optional(),
});

export const getShipmentResponseSchema = invShipmentSchema.extend({
  lines: z.array(shipmentLineSchema),
  packages: z.array(invPackageSchema),
});

export const listPackagesResponseSchema = itemsPagedSchema(invPackageSchema);

export const getPackageResponseSchema = invPackageSchema;

const loadLineSchema = z.object({
  id: z.number().int(),
  loadId: z.number().int(),
  shipmentId: z.number().int().nullable(),
  transferId: z.number().int().nullable(),
});

export const invLoadSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  loadNumber: z.string(),
  sourceWarehouseId: z.number().int().nullable(),
  destination: z.string().nullable(),
  carrierId: z.number().int().nullable(),
  vehicleRef: z.string().nullable(),
  status: z.string(),
  dispatchDate: z.string().nullable(),
  arrivalDate: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(loadLineSchema).optional(),
});

export const listLoadsResponseSchema = itemsPagedSchema(invLoadSchema);

export const getLoadResponseSchema = invLoadSchema;
