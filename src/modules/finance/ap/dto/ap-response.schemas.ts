import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const billStatusResponseSchema = z.object({
  id: z.number().int(),
  status: z.string(),
});

export const billSubmitApprovalResponseSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  approvalRequired: z.boolean(),
});

const paymentRunListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  scheduledDate: z.string().nullable(),
  status: z.enum(["DRAFT", "APPROVED", "COMPLETED", "CANCELLED"]),
  totalAmount: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  itemCount: z.number().int(),
});

export const paymentRunListResponseSchema = cursorPageSchema(paymentRunListItemSchema);

const paymentRunItemSchema = z.object({
  id: z.number().int(),
  runId: z.number().int(),
  billId: z.number().int(),
  billNumber: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  amount: z.string(),
  status: z.enum(["PENDING", "PAID", "SKIPPED"]),
  vendorPaymentId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
});

export const paymentRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  status: z.enum(["DRAFT", "APPROVED", "COMPLETED", "CANCELLED"]),
  scheduledDate: z.string().nullable(),
  totalAmount: z.string(),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const paymentRunDetailResponseSchema = paymentRunRowSchema.extend({
  items: z.array(paymentRunItemSchema),
});

export const paymentRunItemUpdateResponseSchema = z.object({
  id: z.number().int(),
  updated: z.literal(true),
});

export const paymentRunCancelResponseSchema = z.object({
  id: z.number().int(),
  status: z.literal("CANCELLED"),
});

export const paymentRunExecuteResponseSchema = z.object({
  id: z.number().int(),
  status: z.literal("COMPLETED"),
});

const recurringBillListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  frequency: z.string(),
  nextRunDate: z.string().nullable(),
  lastRunDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isActive: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const recurringBillListResponseSchema = cursorPageSchema(recurringBillListItemSchema);

export const recurringBillTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  vendorId: z.number().int().nullable(),
  frequency: z.string(),
  nextRunDate: z.string().nullable(),
  lastRunDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isActive: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const recurringBillDeleteResponseSchema = z.object({
  id: z.number().int(),
  deleted: z.literal(true),
});

export const recurringBillRunNowResponseSchema = z.object({
  templateId: z.number().int(),
  billId: z.number().int(),
  billNumber: z.string(),
});

const vendorCreditListItemSchema = z.object({
  id: z.number().int(),
  vendorCreditNumber: z.string(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  billId: z.number().int().nullable(),
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]),
  reason: z.string().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  appliedAmount: z.string(),
  currency: z.string(),
  createdAt: wireDate(),
});

export const vendorCreditListResponseSchema = cursorPageSchema(vendorCreditListItemSchema);

const vendorCreditItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorCreditId: z.number().int(),
  description: z.string(),
  hsnSacCode: z.string().nullable(),
  quantity: z.string(),
  rate: z.string(),
  gstRate: z.string(),
  amount: z.string(),
  lineOrder: z.number().int(),
});

export const vendorCreditDetailResponseSchema = z.object({
  id: z.number().int(),
  vendorCreditNumber: z.string(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  billId: z.number().int().nullable(),
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]),
  reason: z.string().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  appliedAmount: z.string(),
  currency: z.string(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  items: z.array(vendorCreditItemSchema),
});

export const vendorCreditCreatedResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorCreditNumber: z.string(),
  vendorId: z.number().int().nullable(),
  billId: z.number().int().nullable(),
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]),
  reason: z.string().nullable(),
  subtotal: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  appliedAmount: z.string(),
  currency: z.string(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const vendorCreditPostResponseSchema = z.object({
  id: z.number().int(),
  status: z.literal("POSTED"),
});

export const vendorCreditApplyResponseSchema = z.object({
  id: z.number().int(),
  billId: z.number().int(),
  appliedAmount: z.number(),
});

const vendorPaymentListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  billId: z.number().int(),
  billNumber: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
});

export const vendorPaymentListResponseSchema = cursorPageSchema(vendorPaymentListItemSchema);

export const vendorPaymentAllocateResponseSchema = z.object({
  vendorPaymentId: z.number().int(),
  allocated: z.number().int(),
});
