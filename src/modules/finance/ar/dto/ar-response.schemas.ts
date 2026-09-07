import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

const arPaymentAllocationSchema = z.object({
  invoiceId: z.number().int(),
  amount: z.string(),
});

const arPaymentItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  invoiceId: z.number().int(),
  invoiceNumber: z.string().nullable(),
  clientId: z.number().int().nullable(),
  clientName: z.string().nullable(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  allocations: z.array(arPaymentAllocationSchema),
});

export const arPaymentListResponseSchema = cursorPageSchema(arPaymentItemSchema);

const agingBucketSchema = z.object({
  label: z.string(),
  count: z.number().int(),
  amount: z.number(),
});

const customerRiskSchema = z.object({
  clientId: z.number().int().nullable(),
  overdueAmount: z.number(),
  totalInvoiced: z.number(),
  maxDaysOverdue: z.number().int(),
  riskScore: z.number(),
});

export const collectionSummaryResponseSchema = z.object({
  agingBuckets: z.array(agingBucketSchema),
  topRiskCustomers: z.array(customerRiskSchema),
  asOf: z.string(),
});

const collectionActivitySchema = z.object({
  id: z.number().int(),
  clientId: z.number().int(),
  invoiceId: z.number().int().nullable(),
  type: z.string(),
  note: z.string().nullable(),
  promisedDate: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
});

export const collectionActivityListResponseSchema = cursorPageSchema(collectionActivitySchema);

export const collectionActivityCreatedResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int(),
  invoiceId: z.number().int().nullable(),
  type: z.string(),
  note: z.string().nullable(),
  promisedDate: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
});

export { successSchema as collectionUpdateResponseSchema };

const creditNoteListItemSchema = z.object({
  id: z.number().int(),
  creditNoteNumber: z.string(),
  clientId: z.number().int().nullable(),
  invoiceId: z.number().int().nullable(),
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]),
  reason: z.string().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  appliedAmount: z.string(),
  currency: z.string(),
  placeOfSupply: z.string().nullable(),
  customerGstin: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const creditNoteListResponseSchema = cursorPageSchema(creditNoteListItemSchema);

const creditNoteDetailItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  creditNoteId: z.number().int(),
  description: z.string(),
  hsnSacCode: z.string().nullable(),
  quantity: z.string(),
  rate: z.string(),
  gstRate: z.string(),
  amount: z.string(),
  lineOrder: z.number().int(),
});

export const creditNoteDetailResponseSchema = creditNoteListItemSchema.extend({
  orgId: z.string(),
  cgstAmount: z.string(),
  sgstAmount: z.string(),
  igstAmount: z.string(),
  notes: z.string().nullable(),
  items: z.array(creditNoteDetailItemSchema),
});

export const creditNoteCreatedResponseSchema = creditNoteListItemSchema.extend({
  orgId: z.string(),
  cgstAmount: z.string(),
  sgstAmount: z.string(),
  igstAmount: z.string(),
  notes: z.string().nullable(),
});

export const creditNotePostResponseSchema = z.union([
  z.object({ needsApproval: z.literal(true), creditNoteId: z.number().int() }),
  z.object({ success: z.literal(true), creditNoteNumber: z.string() }),
]);

export { successSchema as creditNoteApplyResponseSchema };

const recurringInvoiceTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  clientId: z.number().int().nullable(),
  frequency: z.string(),
  nextRunDate: z.string().nullable(),
  lastRunDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isActive: z.boolean(),
  archivedAt: nullableWireDate(),
  payload: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const recurringInvoiceListResponseSchema = cursorPageSchema(recurringInvoiceTemplateSchema);

export { recurringInvoiceTemplateSchema as recurringInvoiceTemplateResponseSchema };

export const recurringInvoiceRunNowResponseSchema = z.object({
  invoiceId: z.number().int(),
});

export { successSchema as recurringInvoiceDeleteResponseSchema };

const reminderPolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  offsets: z.array(z.number()),
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  template: z.string().nullable(),
  isActive: z.boolean(),
  archivedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const reminderPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

export const reminderPolicyListResponseSchema = z.object({
  items: z.array(reminderPolicySchema),
  pagination: reminderPaginationSchema,
});

export { reminderPolicySchema as reminderPolicyCreatedResponseSchema };

export { reminderPolicySchema as reminderPolicyUpdatedResponseSchema };

export { successSchema as reminderPolicyDeleteResponseSchema };

const reminderLogItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  invoiceId: z.number().int(),
  scheduledAt: wireDate(),
  sentAt: nullableWireDate(),
  paidAt: nullableWireDate(),
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  offsetDays: z.number().int(),
  status: z.string(),
});

export const reminderLogListResponseSchema = z.object({
  items: z.array(reminderLogItemSchema),
  pagination: reminderPaginationSchema,
});

export const reminderEffectivenessResponseSchema = z.object({
  sent: z.number().int(),
  paidAfterReminder: z.number().int(),
  effectivenessRate: z.number(),
});
