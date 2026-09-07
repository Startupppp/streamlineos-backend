import { z } from "zod";

const balanceSheetRowSchema = z.object({
  accountId: z.number().int(),
  code: z.string(),
  name: z.string(),
  accountType: z.string(),
  balance: z.string(),
});

const trialBalanceRowSchema = balanceSheetRowSchema.extend({
  debit: z.string(),
  credit: z.string(),
});

export const trialBalanceResponseSchema = z.object({
  asOf: z.string(),
  rows: z.array(trialBalanceRowSchema),
  totalDebit: z.string(),
  totalCredit: z.string(),
  balanced: z.boolean(),
});

const plRowSchema = z.object({
  accountId: z.number().int(),
  code: z.string(),
  name: z.string(),
  accountType: z.string(),
  amount: z.string(),
});

export const profitLossResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  income: z.array(plRowSchema),
  expense: z.array(plRowSchema),
  totalIncome: z.string(),
  totalExpense: z.string(),
  netIncome: z.string(),
});

export const balanceSheetResponseSchema = z.object({
  asOf: z.string(),
  assets: z.array(balanceSheetRowSchema),
  liabilities: z.array(balanceSheetRowSchema),
  equity: z.array(balanceSheetRowSchema),
  retainedEarnings: z.string(),
  totalAssets: z.string(),
  totalLiabilities: z.string(),
  totalEquity: z.string(),
  balanced: z.boolean(),
});

const cashFlowItemSchema = z.object({
  label: z.string(),
  amount: z.string(),
});

const cashFlowSectionSchema = z.object({
  key: z.string(),
  label: z.string(),
  items: z.array(cashFlowItemSchema),
  total: z.string(),
});

export const cashFlowResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  openingCash: z.string(),
  closingCash: z.string(),
  netChange: z.string(),
  reconciled: z.boolean(),
  sections: z.array(cashFlowSectionSchema),
});
