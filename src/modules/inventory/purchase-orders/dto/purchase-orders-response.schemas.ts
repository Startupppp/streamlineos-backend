import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() });
const vendorRefSchema = z.object({ id: z.number().int(), name: z.string(), code: z.string() });
const grnPurchaseOrderRefSchema = z.object({
  id: z.number().int(),
  poNumber: z.string(),
  vendorId: z.number().int(),
  vendor: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
});

export const invPoSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorId: z.number().int(),
  poNumber: z.string(),
  status: z.string(),
  orderDate: z.string(),
  expectedDeliveryDate: z.string().nullable(),
  warehouseId: z.number().int().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  discount: z.string(),
  total: z.string(),
  currency: z.string(),
  notes: z.string().nullable(),
  sentAt: wireDate().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const poLineSchema = z.object({
  id: z.number().int(),
  poId: z.number().int(),
  productVariantId: z.number().int(),
  quantity: z.string(),
  quantityReceived: z.string(),
  unitCost: z.string().optional(),
  uomId: z.number().int().nullable(),
  quantityEntered: z.string().nullable(),
  taxRate: z.string(),
  amount: z.string(),
  lineOrder: z.number().int(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: z.object({ id: z.number().int(), name: z.string(), sku: z.string() }),
  }).optional(),
});

const grnLineSchema = z.object({
  id: z.number().int(),
  grnId: z.number().int(),
  poLineId: z.number().int(),
  quantityReceived: z.string(),
  uomId: z.number().int().nullable(),
  quantityEntered: z.string().nullable(),
  status: z.string(),
  rejectionReason: z.string().nullable(),
});

const grnSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  poId: z.number().int(),
  grnNumber: z.string(),
  receivedDate: z.string(),
  locationId: z.number().int().nullable(),
  notes: z.string().nullable(),
  status: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  lines: z.array(grnLineSchema).optional(),
  creator: userRefSchema.optional(),
});

export const listPosResponseSchema = itemsPagedSchema(
  invPoSchema.extend({
    vendor: vendorRefSchema.optional(),
    creator: userRefSchema.optional(),
  }),
);

export const getPoResponseSchema = invPoSchema.extend({
  vendor: z.object({
    id: z.number().int(),
    orgId: z.string(),
    name: z.string(),
    code: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    gstin: z.string().nullable(),
    leadTimeDays: z.number().int(),
    paymentTermsDays: z.number().int(),
    currency: z.string(),
    isActive: z.boolean(),
    notes: z.string().nullable(),
    createdBy: z.string(),
    createdByMembershipId: z.number().int().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
  }).optional(),
  warehouse: z.object({
    id: z.number().int(),
    name: z.string(),
    code: z.string(),
    isActive: z.boolean(),
  }).optional(),
  creator: userRefSchema.optional(),
  lines: z.array(poLineSchema),
  grns: z.array(grnSchema),
});

export const listGrnsResponseSchema = itemsPagedSchema(
  grnSchema.extend({
    purchaseOrder: grnPurchaseOrderRefSchema.nullable().optional(),
  }),
);

export const getGrnResponseSchema = grnSchema.extend({
  purchaseOrder: grnPurchaseOrderRefSchema.nullable().optional(),
  creator: userRefSchema.nullable().optional(),
});

export const reverseGrnResponseSchema = z.object({
  reversed: z.literal(true),
  grnId: z.number().int(),
  transactionCount: z.number().int(),
});
