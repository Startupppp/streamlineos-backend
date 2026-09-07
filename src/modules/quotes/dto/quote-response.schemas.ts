import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const quoteRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dealId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  quoteNumber: z.string(),
  subject: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  currency: z.string(),
  totalAmount: z.string(),
  taxAmount: z.string(),
  discountAmount: z.string(),
  netAmount: z.string(),
  validUntil: z.string(),
  termsAndConditions: z.string().nullable(),
  createdById: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  sentAt: nullableWireDate(),
  acceptedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  pricebookId: z.string().nullable(),
  templateId: z.string().nullable(),
  approvalStatus: z.enum(["pending", "approved", "rejected"]).nullable(),
  approvedById: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  signedAt: nullableWireDate(),
  signedDocumentRef: z.string().nullable(),
  documentKey: z.string().nullable(),
  convertedInvoiceId: z.number().int().nullable(),
  exchangeRate: z.string(),
  deletedAt: nullableWireDate(),
});

const quoteLineItemSchema = z.object({
  id: z.number().int(),
  quoteId: z.number().int(),
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
  taxRate: z.string(),
  displayOrder: z.number().int(),
  createdAt: wireDate(),
});

export const quoteDetailResponseSchema = quoteRowSchema.extend({
  lineItems: z.array(quoteLineItemSchema),
  createdBy: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }),
  deal: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  client: z.object({ id: z.number().int(), clientName: z.string() }).nullable(),
});

export const quoteCreateResponseSchema = quoteRowSchema;

export const quoteUpdateResponseSchema = quoteRowSchema;

export const quoteRemoveResponseSchema = z.object({ success: z.literal(true) });

export const quoteSendResponseSchema = quoteRowSchema;

export const quoteApproveResponseSchema = quoteRowSchema;

export const quoteRejectResponseSchema = quoteRowSchema;

const invoiceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
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
  sentAt: nullableWireDate(),
  paidAt: nullableWireDate(),
  viewedAt: nullableWireDate(),
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
  nextReminderAt: nullableWireDate(),
  recurringTemplateId: z.number().int().nullable(),
});

export const quoteConvertToInvoiceResponseSchema = z.object({
  invoice: invoiceRowSchema,
  quoteId: z.number().int(),
});

export const quoteMarkSignedResponseSchema = quoteRowSchema;

export const quoteListResponseSchema = z.object({
  quotes: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      dealId: z.number().int().nullable(),
      clientId: z.number().int().nullable(),
      quoteNumber: z.string(),
      subject: z.string(),
      status: z.string(),
      currency: z.string(),
      totalAmount: z.string(),
      netAmount: z.string(),
      validUntil: z.string(),
      createdById: z.string(),
      sentAt: nullableWireDate(),
      acceptedAt: nullableWireDate(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
      createdBy: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable(),
      deal: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
      client: z.object({ id: z.number().int(), clientName: z.string().nullable() }).nullable(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
