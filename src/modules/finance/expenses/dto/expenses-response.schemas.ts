import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const categorizeSuggestResponseSchema = z.object({
  categoryId: z.number().int().nullable(),
  categoryName: z.string().nullable(),
  confidence: z.number(),
  basis: z.enum(["none", "history"]),
});

const expenseCategorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  budgetLimit: z.string().nullable(),
  budgetPeriod: z.string(),
  isActive: z.boolean(),
  ledgerAccountId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const expensePolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  categoryId: z.number().int().nullable(),
  maxAmount: z.string().nullable(),
  requiresReceiptAbove: z.string().nullable(),
  requiresApprovalAbove: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  category: expenseCategorySchema.nullable(),
});

export const expensePolicyListResponseSchema = z.array(expensePolicySchema);

export const expensePolicyCreatedResponseSchema = expensePolicySchema.omit({ category: true });

const expenseUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

const expenseWithRelationsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  categoryId: z.number().int().nullable(),
  category: z.string(),
  amount: z.string(),
  currency: z.string(),
  description: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  receiptFileName: z.string().nullable(),
  merchant: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  receiptHash: z.string().nullable(),
  taxAmount: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  projectId: z.number().int().nullable(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  paidAt: nullableWireDate(),
  transactionRef: z.string().nullable(),
  reimbursementBatchId: z.number().int().nullable(),
  postedJournalEntryId: z.number().int().nullable(),
  policyFlag: z.string().nullable(),
  expenseDate: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: expenseUserSchema,
  expenseCategory: expenseCategorySchema.nullable(),
});

export const receiptInboxListResponseSchema = z.object({
  items: z.array(expenseWithRelationsSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

const reimbursementBatchActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

export const reimbursementBatchSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  status: z.string(),
  totalAmount: z.string(),
  paidDate: z.string().nullable(),
  journalEntryId: z.number().int().nullable(),
  bankAccountId: z.number().int().nullable(),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: reimbursementBatchActorSchema,
  approver: reimbursementBatchActorSchema.nullable(),
});

export const reimbursementBatchCreatedResponseSchema = reimbursementBatchSchema.omit({ creator: true, approver: true });

export const reimbursementBatchListResponseSchema = z.object({
  data: z.array(reimbursementBatchSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const reimbursementExpenseItemSchema = z.object({
  id: z.number().int(),
  amount: z.string(),
  category: z.string(),
  expenseDate: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const reimbursementBatchDetailResponseSchema = z.object({
  batch: reimbursementBatchSchema,
  items: z.array(reimbursementExpenseItemSchema),
});

export const reimbursementPayResponseSchema = z.object({
  success: z.literal(true),
  replayed: z.boolean(),
  entryId: z.number().int().nullable(),
});

export { successSchema };
