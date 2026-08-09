import { z } from "zod";

const ALL_EXPENSE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REIMBURSEMENT_PENDING",
  "REIMBURSED",
  "PAID",
] as const;
const SORTABLE = ["date", "amount", "category", "status", "created"] as const;

export const listSchema = z.object({
  userId: z.string().min(1).optional(),
  status: z.enum(ALL_EXPENSE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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

export const selfExpensePageDataSchema = pageDataSchema.omit({ userId: true });

export const reportSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export const exportSchema = z.object({
  status: z.enum(ALL_EXPENSE_STATUSES).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const emailReportFiltersSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  month: z.string().optional(),
  categoryId: z.number().int().optional(),
  category: z.string().max(100).optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  userId: z.string().optional(),
  paymentMethod: z.string().max(100).optional(),
  minAmount: z.number().nonnegative().optional(),
  maxAmount: z.number().nonnegative().optional(),
  search: z.string().max(200).optional(),
});

export const emailReportSchema = z.object({
  filters: emailReportFiltersSchema,
  sendTo: z.enum(["ADMINS", "APPROVERS", "BOTH"]).default("BOTH"),
});

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  budgetLimit: z.number().positive().optional(),
  budgetPeriod: z.enum(["MONTHLY", "YEARLY"]).optional().default("MONTHLY"),
  ledgerAccountId: z.number().int().positive().optional(),
});

const AMOUNT = z
  .number()
  .positive("Amount must be greater than 0")
  .max(999_999_999.99, "Amount cannot exceed 999,999,999.99");

const EXPENSE_LABEL_RE = /^[\p{L}\p{N}\s'.-]+$/u;
const CONSECUTIVE_SPECIAL_RE = /[^\p{L}\p{N}\s]{2,}/u;

function isValidExpenseLabel(v: string): boolean {
  return (
    /[a-zA-Z]/.test(v) &&
    EXPENSE_LABEL_RE.test(v) &&
    !CONSECUTIVE_SPECIAL_RE.test(v)
  );
}

const expenseLabelSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(100)
  .refine(isValidExpenseLabel, {
    message:
      "Can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
  });

/** Empty string / whitespace → undefined so optional selects stay valid. */
const optionalExpenseLabelSchema = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  })
  .refine((v) => v === undefined || (v.length <= 100 && isValidExpenseLabel(v)), {
    message:
      "Can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
  });

const optionalMerchantSchema = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  })
  .refine(
    (v) =>
      v === undefined ||
      (v.length <= 200 && EXPENSE_LABEL_RE.test(v) && !CONSECUTIVE_SPECIAL_RE.test(v)),
    {
      message:
        "Merchant can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
    },
  );

const clearableMerchantSchema = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    return t ? t : null;
  })
  .refine(
    (v) =>
      v === undefined ||
      v === null ||
      (v.length <= 200 && EXPENSE_LABEL_RE.test(v) && !CONSECUTIVE_SPECIAL_RE.test(v)),
    {
      message:
        "Merchant can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
    },
  );

const clearableExpenseLabelSchema = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    return t ? t : null;
  })
  .refine(
    (v) => v === undefined || v === null || (v.length <= 100 && isValidExpenseLabel(v)),
    {
      message:
        "Can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
    },
  );

export const createExpenseSchema = z.object({
  category: expenseLabelSchema,
  categoryId: z.number().int().optional(),
  amount: AMOUNT,
  description: z.string().max(1000).optional(),
  receiptUrl: z.string().optional(),
  receiptFileName: z.string().optional(),
  merchant: optionalMerchantSchema,
  paymentMethod: optionalExpenseLabelSchema,
  projectId: z.number().int().optional(),
  expenseDate: z.string(),
});

export const updateExpenseStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PAID"]),
  rejectionReason: z.string().optional(),
});

export const updateExpenseDetailsSchema = z.object({
  category: expenseLabelSchema.optional(),
  amount: AMOUNT.optional(),
  description: z.string().max(1000).optional(),
  merchant: clearableMerchantSchema,
  paymentMethod: clearableExpenseLabelSchema,
  expenseDate: z.string().optional(),
  receiptUrl: z.string().optional(),
  receiptFileName: z.string().optional(),
});

export const rejectExpenseSchema = z.object({
  rejectionReason: z.string().max(1000).optional(),
});

export const updateExpensePatchSchema = z.union([
  updateExpenseStatusSchema,
  updateExpenseDetailsSchema,
]);

export type AllExpenseStatus = (typeof ALL_EXPENSE_STATUSES)[number];
export type ListInput = z.infer<typeof listSchema>;
export type PageDataInput = z.infer<typeof pageDataSchema>;
export type SelfExpensePageDataInput = z.infer<
  typeof selfExpensePageDataSchema
>;
export type ReportInput = z.infer<typeof reportSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type EmailReportFilters = z.infer<typeof emailReportFiltersSchema>;
export type EmailReportInput = z.infer<typeof emailReportSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type RejectExpenseInput = z.infer<typeof rejectExpenseSchema>;
export type UpdateExpensePatchInput = z.infer<typeof updateExpensePatchSchema>;
export type UpdateExpenseDetailsInput = z.infer<
  typeof updateExpenseDetailsSchema
>;
