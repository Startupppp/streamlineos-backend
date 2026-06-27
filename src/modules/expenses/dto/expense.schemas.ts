import { z } from "zod";

const EXPENSE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "PAID"] as const;
const SORTABLE = ["date", "amount", "category", "status", "created"] as const;

export const listSchema = z.object({
  userId: z.string().min(1).optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const pageDataSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(SORTABLE).default("date"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  userId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  month: z.string().optional(),
  categoryId: z.coerce.number().int().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  minAmount: z.coerce.number().optional(),
  maxAmount: z.coerce.number().optional(),
  paymentMethod: z.string().optional(),
  search: z.string().optional(),
});

export const reportSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export const exportSchema = z.object({
  status: z.enum(EXPENSE_STATUSES).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  budgetLimit: z.number().positive().optional(),
  budgetPeriod: z.enum(["MONTHLY", "YEARLY"]).optional().default("MONTHLY"),
});

const AMOUNT = z
  .number()
  .positive("Amount must be greater than 0")
  .max(999_999_999.99, "Amount cannot exceed 999,999,999.99");

export const createExpenseSchema = z.object({
  category: z.string(),
  categoryId: z.number().int().optional(),
  amount: AMOUNT,
  description: z.string().optional(),
  receiptUrl: z.string().optional(),
  receiptFileName: z.string().optional(),
  merchant: z.string().optional(),
  paymentMethod: z.string().optional(),
  projectId: z.number().int().optional(),
  expenseDate: z.string(),
});

export const updateExpenseStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PAID"]),
  rejectionReason: z.string().optional(),
});

export const updateExpenseDetailsSchema = z.object({
  category: z.string().optional(),
  amount: AMOUNT.optional(),
  description: z.string().optional(),
  merchant: z.string().optional(),
  paymentMethod: z.string().optional(),
  expenseDate: z.string().optional(),
  receiptUrl: z.string().optional(),
  receiptFileName: z.string().optional(),
});

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export type ListInput = z.infer<typeof listSchema>;
export type PageDataInput = z.infer<typeof pageDataSchema>;
export type ReportInput = z.infer<typeof reportSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseStatusInput = z.infer<typeof updateExpenseStatusSchema>;
export type UpdateExpenseDetailsInput = z.infer<typeof updateExpenseDetailsSchema>;
