import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

export const invSoSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  soNumber: z.string(),
  status: z.string(),
  orderDate: z.string(),
  requiredDate: z.string().nullable(),
  shippingAddress: z.string().nullable(),
  warehouseId: z.number().int().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  discount: z.string(),
  total: z.string(),
  currency: z.string(),
  notes: z.string().nullable(),
  invoiceId: z.number().int().nullable(),
  confirmedAt: wireDate().nullable(),
  shippedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const soLineSchema = z.object({
  id: z.number().int(),
  soId: z.number().int(),
  productVariantId: z.number().int(),
  quantity: z.string(),
  quantityShipped: z.string(),
  unitPrice: z.string(),
  uomId: z.number().int().nullable(),
  quantityEntered: z.string().nullable(),
  taxRate: z.string(),
  amount: z.string(),
  costAtTime: z.string().optional(),
  lineOrder: z.number().int(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: z.object({ id: z.number().int(), name: z.string(), sku: z.string() }),
  }).optional(),
});

export const listSosResponseSchema = itemsPagedSchema(
  invSoSchema.extend({
    client: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
    creator: userRefSchema.optional(),
  }),
);

export const getSoResponseSchema = invSoSchema.extend({
  client: z.record(z.string(), z.unknown()).nullable().optional(),
  warehouse: z.record(z.string(), z.unknown()).nullable().optional(),
  invoice: z.record(z.string(), z.unknown()).nullable().optional(),
  creator: userRefSchema.optional(),
  lines: z.array(soLineSchema),
});

export const invoiceSoResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  invoiceNumber: z.string(),
  status: z.string(),
  subtotal: z.string(),
  taxRate: z.string(),
  taxAmount: z.string(),
  discount: z.string(),
  total: z.string(),
  currency: z.string(),
  dueDate: z.string().nullable(),
  notes: z.string().nullable(),
  sentAt: wireDate().nullable(),
  paidAt: wireDate().nullable(),
  viewedAt: wireDate().nullable(),
  terms: z.string().nullable(),
  placeOfSupply: z.string().nullable(),
  customerGstin: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  reverseCharge: z.boolean(),
  taxInclusive: z.boolean(),
  cgstAmount: z.string(),
  sgstAmount: z.string(),
  igstAmount: z.string(),
  isRecurring: z.boolean(),
  recurringInterval: z.string().nullable(),
  nextRecurringDate: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  amountPaid: z.string(),
  exchangeRate: z.string(),
  collectionOwnerId: z.string().nullable(),
  collectionOwnerMembershipId: z.number().int().nullable(),
  promiseToPayDate: z.string().nullable(),
  nextReminderAt: wireDate().nullable(),
  recurringTemplateId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
});

export const reserveSoResponseSchema = z.object({
  soId: z.number().int(),
  status: z.string(),
  allReserved: z.boolean(),
});

export const pickSoResponseSchema = z.object({
  pickListId: z.number().int(),
  pickNumber: z.string(),
  allPicked: z.boolean(),
});

export const packSoResponseSchema = z.object({
  soId: z.number().int(),
  status: z.literal("PACKED"),
  packageId: z.number().int(),
});

export const shipSoResponseSchema = z.object({
  shipmentId: z.number().int(),
  shipmentNumber: z.string(),
  status: z.string(),
  isPartial: z.boolean(),
});

export const atpResponseSchema = z.array(z.object({
  productVariantId: z.number().int(),
  onHand: z.number(),
  committed: z.number(),
  blocked: z.number(),
  qualityHold: z.number(),
  onOrder: z.number(),
  available: z.number(),
  incomingQty: z.number(),
  outgoingQty: z.number(),
}));
