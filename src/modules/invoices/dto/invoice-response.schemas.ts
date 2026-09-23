import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../common/openapi/response-envelopes";

const invoiceBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  dealId: z.number().int().nullable(),
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

const clientBriefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const projectBriefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const userBriefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});

const invoiceListItemSchema = invoiceBaseSchema.extend({
  client: clientBriefSchema.nullable(),
  project: projectBriefSchema.nullable(),
  creator: userBriefSchema,
});

export const invoiceListResponseSchema = itemsPagedSchema(invoiceListItemSchema);

export const invoiceStatsResponseSchema = z.object({
  draft: z.number().int(),
  issued: z.number().int(),
  paid: z.number().int(),
  failed: z.number().int(),
  voided: z.number().int(),
  totalOutstanding: z.number(),
  totalPaid: z.number(),
});

export const recurringInvoiceListResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    invoiceNumber: z.string(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    total: z.string(),
    currency: z.string(),
    status: z.string(),
    recurringInterval: z.string().nullable(),
    nextRecurringDate: z.string().nullable(),
    overdue: z.boolean(),
  }),
);

const clientFullSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  leadId: z.number().int().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  designation: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  gstin: z.string().nullable(),
  isVendor: z.boolean(),
  investmentValue: z.string().nullable(),
  status: z.string(),
  accountManagerId: z.string().nullable(),
  accountManagerMembershipId: z.number().int().nullable(),
  notes: z.string().nullable(),
  healthScore: z.number().int(),
  healthStatus: z.string(),
  lastHealthCheck: nullableWireDate(),
  churnRiskScore: z.number().int().nullable(),
  churnRiskReasoning: z.string().nullable(),
  convertedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const invoiceDetailPaymentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  invoiceId: z.number().int(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  creator: userBriefSchema,
});

export const invoiceDetailResponseSchema = invoiceBaseSchema.extend({
  client: clientFullSchema.nullable(),
  project: projectBriefSchema.nullable(),
  creator: userBriefSchema,
  payments: z.array(invoiceDetailPaymentSchema),
  lineItems: z.array(
    z.object({
      id: z.number().int(),
      description: z.string(),
      hsnSacCode: z.string().nullable(),
      quantity: z.string(),
      rate: z.string(),
      gstRate: z.string(),
      amount: z.string(),
      lineOrder: z.number().int(),
      timesheetEntryId: z.number().int().nullable(),
    }),
  ),
});

export const invoicePaymentsListResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    orgId: z.string(),
    invoiceId: z.number().int(),
    amount: z.string(),
    paymentDate: z.string(),
    paymentMethod: z.string(),
    referenceNumber: z.string().nullable(),
    notes: z.string().nullable(),
    createdBy: z.string(),
    createdByMembershipId: z.number().int().nullable(),
    createdAt: wireDate(),
    creator: userBriefSchema,
  }),
);

export const invoiceCreateResponseSchema = invoiceBaseSchema;

export const invoiceFromTimesheetsResponseSchema = z.object({
  invoice: invoiceBaseSchema,
  timesheetEntryIds: z.array(z.number().int()),
  posted: z.boolean(),
});

export const invoiceRecordPaymentResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  invoiceId: z.number().int(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const invoiceRunRecurringResponseSchema = z.object({
  generated: z.number().int(),
  invoiceIds: z.array(z.number().int()),
  failedIds: z.array(z.number().int()),
});

export const invoiceSuccessResponseSchema = z.object({ success: z.literal(true) });
