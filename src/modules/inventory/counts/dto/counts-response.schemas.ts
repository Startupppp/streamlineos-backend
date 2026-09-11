import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const productRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  sku: z.string(),
});

const countLineSchema = z.object({
  id: z.number().int(),
  productVariantId: z.number().int(),
  locationId: z.number().int(),
  lotId: z.number().int().nullable(),
  systemQty: z.string(),
  countedQty: z.string().nullable(),
  varianceQty: z.string().nullable(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: productRefSchema,
  }).optional(),
  location: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).optional(),
});

export const cycleCountSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  countNumber: z.string(),
  warehouseId: z.number().int(),
  locationId: z.number().int().nullable(),
  categoryId: z.number().int().nullable(),
  status: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  postedAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  lines: z.array(countLineSchema).optional(),
});

export const listCycleCountsResponseSchema = itemsPagedSchema(cycleCountSchema);

const auditLineSchema = z.object({
  id: z.number().int(),
  auditId: z.number().int(),
  productVariantId: z.number().int(),
  locationId: z.number().int(),
  lotId: z.number().int().nullable(),
  systemQty: z.string(),
  countedQty: z.string().nullable(),
  varianceQty: z.string().nullable(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: productRefSchema,
  }).optional(),
  location: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).optional(),
});

export const physicalAuditSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  auditNumber: z.string(),
  warehouseId: z.number().int(),
  status: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  postedAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  lines: z.array(auditLineSchema).optional(),
});

export const listAuditsResponseSchema = itemsPagedSchema(physicalAuditSchema);
