import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

const vendorReturnLineSchema = z.object({
  id: z.number().int(),
  returnId: z.number().int(),
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
  status: z.string().optional(),
  unitCost: z.string().nullable().optional(),
});

const vendorReturnSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  returnNumber: z.string(),
  vendorId: z.number().int(),
  poId: z.number().int().nullable(),
  grnId: z.number().int().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  postedAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: userRefSchema.optional(),
  approver: userRefSchema.nullable().optional(),
  lines: z.array(vendorReturnLineSchema).optional(),
});

export const listVendorReturnsResponseSchema = itemsPagedSchema(vendorReturnSchema);

export const getVendorReturnResponseSchema = vendorReturnSchema;

const customerReturnLineSchema = z.object({
  id: z.number().int(),
  returnId: z.number().int(),
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  quantity: z.string(),
  notes: z.string().nullable(),
});

const customerReturnSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  returnNumber: z.string(),
  soId: z.number().int().nullable(),
  shipmentId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  postedAt: wireDate().nullable(),
  cancelledAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: userRefSchema.optional(),
  approver: userRefSchema.nullable().optional(),
  lines: z.array(customerReturnLineSchema).optional(),
});

export const listCustomerReturnsResponseSchema = itemsPagedSchema(customerReturnSchema);

export const getCustomerReturnResponseSchema = customerReturnSchema;
