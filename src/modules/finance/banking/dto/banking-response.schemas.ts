import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const bankAccountSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  accountType: z.enum(["BANK", "CASH", "CARD", "WALLET"]),
  accountNumberMasked: z.string().nullable(),
  bankName: z.string().nullable(),
  ifsc: z.string().nullable(),
  currency: z.string(),
  ledgerAccountId: z.number().int().nullable(),
  openingBalance: z.string(),
  currentBalance: z.string(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const bankAccountListResponseSchema = cursorPageSchema(bankAccountSchema);

const bankTransactionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  bankAccountId: z.number().int(),
  importId: z.number().int().nullable(),
  txnDate: z.string(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  amount: z.string(),
  balanceAfter: z.string().nullable(),
  counterparty: z.string().nullable(),
  fingerprint: z.string(),
  status: z.enum(["UNMATCHED", "SUGGESTED", "MATCHED", "RECONCILED", "IGNORED"]),
  matchedJournalEntryId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const bankTransactionListResponseSchema = cursorPageSchema(bankTransactionSchema);

const bankImportSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  bankAccountId: z.number().int(),
  fileName: z.string(),
  format: z.enum(["CSV", "OFX", "MANUAL"]),
  rowCount: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]),
  columnMapping: z.unknown().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const bankImportListResponseSchema = cursorPageSchema(bankImportSchema);

export const bankImportCreateResponseSchema = z.object({
  id: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  totalRows: z.number().int(),
});

const reconMatchSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  bankTransactionId: z.number().int(),
  journalEntryId: z.number().int().nullable(),
  matchedType: z.enum(["CUSTOMER_PAYMENT", "VENDOR_PAYMENT", "EXPENSE_REIMBURSEMENT", "PAYROLL", "BANK_FEE", "TRANSFER", "MANUAL_JOURNAL"]),
  matchedRecordId: z.number().int().nullable(),
  amount: z.string(),
  confidence: z.string().nullable(),
  isConfirmed: z.boolean(),
  confirmedByMembershipId: z.number().int().nullable(),
  confirmedAt: nullableWireDate(),
  createdAt: wireDate(),
});

const bankTxnWithMatchesSchema = bankTransactionSchema.extend({
  suggestedMatches: z.array(reconMatchSchema),
});

export const reconWorkspaceResponseSchema = z.object({
  unmatched: z.array(bankTransactionSchema),
  suggested: z.array(bankTxnWithMatchesSchema),
  reconciledCount: z.number().int(),
  ledgerBalance: z.string().nullable(),
  bankBalance: z.string(),
});

export const reconRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  priority: z.number().int(),
  conditions: z.unknown(),
  action: z.unknown(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const reconRuleListResponseSchema = cursorPageSchema(reconRuleSchema);

export const bankTransferSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fromBankAccountId: z.number().int(),
  toBankAccountId: z.number().int(),
  amount: z.string(),
  transferDate: z.string(),
  reference: z.string().nullable(),
  journalEntryId: z.number().int().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const bankTransferListResponseSchema = cursorPageSchema(bankTransferSchema);

export { successSchema };
