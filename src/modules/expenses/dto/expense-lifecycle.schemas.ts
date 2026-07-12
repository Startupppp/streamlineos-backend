import { z } from "zod";

export const submitExpenseSchema = z.object({
  expenseId: z.number().int().positive(),
});

export const extendedStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PAID", "SUBMITTED", "REIMBURSEMENT_PENDING", "REIMBURSED"]),
  rejectionReason: z.string().optional(),
});

export const ALL_EXPENSE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REIMBURSEMENT_PENDING",
  "REIMBURSED",
  "PAID",
] as const;

export type AllExpenseStatus = (typeof ALL_EXPENSE_STATUSES)[number];

export type SubmitExpenseInput = z.infer<typeof submitExpenseSchema>;
export type ExtendedStatusInput = z.infer<typeof extendedStatusSchema>;
