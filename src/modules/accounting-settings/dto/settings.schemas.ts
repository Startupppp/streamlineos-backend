import { z } from "zod";

export const updateSettingsSchema = z.object({
  baseCurrency: z.string().length(3).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  accountingBasis: z.enum(["ACCRUAL", "CASH"]).optional(),
  taxRegistration: z.record(z.string(), z.unknown()).optional(),
  coaTemplate: z.string().optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const updateSequenceSchema = z.object({
  prefix: z.string().min(1).max(20).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  nextNumber: z.number().int().min(1).optional(),
});

export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;

export const SEQUENCE_ENTITY_TYPES = [
  "journal",
  "invoice",
  "credit_note",
  "bill",
  "vendor_credit",
  "payment",
  "asset",
] as const;

export type SequenceEntityType = (typeof SEQUENCE_ENTITY_TYPES)[number];

export const systemAccountPurposeSchema = z.enum([
  "AR",
  "AP",
  "BANK_CLEARING",
  "SALES_INCOME",
  "DISCOUNT_GIVEN",
  "TAX_PAYABLE",
  "TAX_RECEIVABLE",
  "PAYROLL_PAYABLE",
  "EXPENSE_CLEARING",
  "RETAINED_EARNINGS",
  "OWNER_EQUITY",
  "PAYMENT_FEES",
  "REIMBURSEMENT_PAYABLE",
  "FX_GAIN_LOSS",
  "DEPRECIATION_EXPENSE",
  "ACCUM_DEPRECIATION",
]);

export type SystemAccountPurpose = z.infer<typeof systemAccountPurposeSchema>;

export const upsertSystemAccountSchema = z.object({
  accountId: z.number().int().positive(),
});

export type UpsertSystemAccountInput = z.infer<typeof upsertSystemAccountSchema>;

export const openingBalanceLineSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.number().min(0).optional(),
  credit: z.number().min(0).optional(),
});

export const postOpeningBalancesSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(openingBalanceLineSchema).min(1),
});

export type PostOpeningBalancesInput = z.infer<typeof postOpeningBalancesSchema>;
