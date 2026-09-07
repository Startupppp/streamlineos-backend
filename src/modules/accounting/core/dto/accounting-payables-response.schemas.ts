import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const billBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorId: z.number().int().nullable(),
  billNumber: z.string(),
  vendorBillNumber: z.string().nullable(),
  billDate: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
  subtotal: z.string(),
  taxAmount: z.string(),
  cgstAmount: z.string(),
  sgstAmount: z.string(),
  igstAmount: z.string(),
  discount: z.string(),
  total: z.string(),
  amountPaid: z.string(),
  currency: z.string(),
  placeOfSupply: z.string().nullable(),
  vendorGstin: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  reverseCharge: z.boolean(),
  notes: z.string().nullable(),
  expenseAccountCode: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const billRowSchema = billBaseSchema.extend({ vendorName: z.string().nullable() });

export const purchaseBillListResponseSchema = cursorPageSchema(billRowSchema);

const billItemSchema = z.object({
  id: z.number().int(),
  billId: z.number().int(),
  description: z.string(),
  hsnSacCode: z.string().nullable(),
  quantity: z.string(),
  rate: z.string(),
  gstRate: z.string(),
  amount: z.string(),
  lineOrder: z.number().int(),
});

export const purchaseBillDetailResponseSchema = billRowSchema.extend({
  items: z.array(billItemSchema),
});

export const purchaseBillCreatedResponseSchema = billBaseSchema.extend({
  createdByMembershipId: z.number().int().nullable(),
  exchangeRate: z.string(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  recurringTemplateId: z.number().int().nullable(),
});

export const billStatusUpdateResponseSchema = z.object({
  id: z.number().int(),
  status: z.string(),
});

const vendorPaymentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  billId: z.number().int(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
});

export const billPaymentListResponseSchema = z.array(vendorPaymentSchema);

export const billPaymentCreatedResponseSchema = vendorPaymentSchema.extend({
  createdByMembershipId: z.number().int().nullable(),
});

export const vendorListResponseSchema = cursorPageSchema(
  z.object({
    vendorId: z.number().int(),
    vendorName: z.string().nullable(),
    state: z.string().nullable(),
    gstin: z.string().nullable(),
    billCount: z.number().int(),
    outstanding: z.string(),
  }),
);

const vendorLedgerLineSchema = z.object({
  date: z.string(),
  entryId: z.number().int(),
  entryNumber: z.string(),
  sourceType: z.string(),
  sourceEvent: z.string().nullable(),
  description: z.string().nullable(),
  billId: z.number().int().nullable(),
  billNumber: z.string().nullable(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string(),
});

export const vendorLedgerResponseSchema = z.object({
  summary: z.object({
    vendorId: z.number().int(),
    vendorName: z.string(),
    state: z.string().nullable(),
    gstin: z.string().nullable(),
    totalBilled: z.string(),
    totalPaid: z.string(),
    outstanding: z.string(),
  }),
  lines: z.array(vendorLedgerLineSchema),
});

const agingRowSchema = z.object({
  current: z.string(),
  d1_30: z.string(),
  d31_60: z.string(),
  d61_90: z.string(),
  d91_plus: z.string(),
  total: z.string(),
});

export const agedPayablesResponseSchema = z.object({
  asOf: z.string(),
  rows: z.array(agingRowSchema.extend({ vendorId: z.number().int(), vendorName: z.string() })),
  totals: agingRowSchema,
});
