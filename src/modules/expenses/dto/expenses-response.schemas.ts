import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const expenseRowSchema = z.object({
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
});

export const expenseCategoryRowSchema = z.object({
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

export const expenseCategoryWithStatsSchema = expenseCategoryRowSchema.extend({
  totalSpent: z.number(),
  pendingAmount: z.number(),
  approvedAmount: z.number(),
  expenseCount: z.number(),
});

export const expenseExportJobViewSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "expired"]),
  processedRows: z.number().int(),
  rowCount: z.number().int().nullable(),
  truncated: z.boolean(),
  fileName: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  completedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
});

export const expenseListResponseSchema = z.object({
  data: z.array(expenseRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  totalPages: z.number().int(),
});

const expenseStatsSchema = z.object({
  totalAmount: z.number(),
  pendingAmount: z.number(),
  approvedAmount: z.number(),
  rejectedAmount: z.number(),
  paidAmount: z.number(),
  totalCount: z.number(),
  pendingCount: z.number(),
  approvedCount: z.number(),
  rejectedCount: z.number(),
  paidCount: z.number(),
  avgExpenseAmount: z.number(),
});

const expensePersonRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

export const expensePageDataRowSchema = expenseRowSchema.extend({
  user: expensePersonRefSchema.nullable(),
  approver: expensePersonRefSchema.nullable(),
  expenseCategory: expenseCategoryRowSchema.nullable(),
});

export const expensePageDataResponseSchema = z.object({
  expenses: z.array(expensePageDataRowSchema),
  pendingExpenses: z.array(expensePageDataRowSchema),
  stats: expenseStatsSchema,
  categories: z.array(expenseCategoryRowSchema),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
  isAdmin: z.boolean(),
});

export const expenseReportResponseSchema = z.object({
  summary: z.object({
    totalExpenses: z.number(),
    totalAmount: z.number(),
    approvedAmount: z.number(),
    rejectedAmount: z.number(),
    pendingAmount: z.number(),
    avgExpenseAmount: z.number(),
  }),
  byCategory: z.array(
    z.object({
      category: z.string(),
      count: z.number(),
      amount: z.number(),
      percentage: z.number(),
    }),
  ),
  byEmployee: z.array(
    z.object({
      userId: z.string(),
      userName: z.string(),
      count: z.number(),
      amount: z.number(),
    }),
  ),
  byMonth: z.array(
    z.object({
      month: z.string(),
      count: z.number(),
      amount: z.number(),
    }),
  ),
  byStatus: z.array(
    z.object({
      status: z.string(),
      count: z.number(),
      amount: z.number(),
    }),
  ),
  topExpenses: z.array(
    z.object({
      id: z.number().int(),
      category: z.string(),
      amount: z.number(),
      description: z.string(),
      userName: z.string(),
      expenseDate: z.string(),
    }),
  ),
});

export const expenseImportResultSchema = z.object({
  success: z.literal(true),
  count: z.number().int(),
  skipped: z.number().int(),
  skippedReasons: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  /**
   * Rows that repeat an earlier row in the same file (`matchesRow`) or an expense the
   * org already holds (`matchesExpenseId`). Unless the caller sent `confirmDuplicates`
   * these rows were NOT inserted, so `count` is the number actually filed. [V-070b]
   */
  duplicateWarnings: z.array(
    z.object({
      row: z.number().int(),
      matchesRow: z.number().int().optional(),
      matchesExpenseId: z.number().int().optional(),
      inserted: z.boolean(),
    }),
  ),
  warning: z.string().optional(),
});

export const expenseSubmitResponseSchema = z.object({
  success: z.literal(true),
  approvalRequired: z.boolean(),
  policyFlag: z.string().nullable(),
  duplicateOf: z.number().int().nullable(),
});

export const expenseApproveResponseSchema = z.object({
  success: z.literal(true),
  entryId: z.number().int().nullable(),
});
