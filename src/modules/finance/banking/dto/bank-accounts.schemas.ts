import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const createBankAccountSchema = z.object({
  name: z.string().min(1).max(200),
  accountType: z.enum(["BANK", "CASH", "CARD", "WALLET"]).default("BANK"),
  accountNumberMasked: z.string().max(50).optional(),
  bankName: z.string().max(200).optional(),
  ifsc: z.string().max(20).optional(),
  currency: z.string().length(3).default("INR"),
  ledgerAccountId: z.number().int().positive().optional(),
  openingBalance: z.string().regex(/^-?\d+(\.\d{1,4})?$/).default("0"),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateBankAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  accountType: z.enum(["BANK", "CASH", "CARD", "WALLET"]).optional(),
  accountNumberMasked: z.string().max(50).optional(),
  bankName: z.string().max(200).optional(),
  ifsc: z.string().max(20).optional(),
  currency: z.string().length(3).optional(),
  isActive: z.boolean().optional(),
});

export const bankAccountsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  isActive: queryBoolean.optional(),
  q: z.string().max(200).optional(),
});

export const bankTransactionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  status: z.enum(["UNMATCHED", "SUGGESTED", "MATCHED", "RECONCILED", "IGNORED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().max(200).optional(),
});

export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
export type BankAccountsQuery = z.infer<typeof bankAccountsQuerySchema>;
export type BankTransactionsQuery = z.infer<typeof bankTransactionsQuerySchema>;
