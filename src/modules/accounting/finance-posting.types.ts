export type SystemAccountPurpose =
  | "AR"
  | "AP"
  | "BANK_CLEARING"
  | "SALES_INCOME"
  | "DISCOUNT_GIVEN"
  | "TAX_PAYABLE"
  | "TAX_RECEIVABLE"
  | "PAYROLL_PAYABLE"
  | "EXPENSE_CLEARING"
  | "RETAINED_EARNINGS"
  | "OWNER_EQUITY"
  | "PAYMENT_FEES"
  | "REIMBURSEMENT_PAYABLE"
  | "FX_GAIN_LOSS"
  | "DEPRECIATION_EXPENSE"
  | "ACCUM_DEPRECIATION";

export interface PostJournalLine {
  accountId?: number;
  systemPurpose?: SystemAccountPurpose;
  debit?: string;
  credit?: string;
  description?: string;
  clientId?: number;
  vendorId?: number;
  projectId?: number;
  departmentId?: number;
  employeeId?: number;
  taxCodeId?: number;
  dimensionValues?: Record<string, string>;
}

export interface PostJournalInput {
  entryDate: string;
  postingDate?: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
  currency?: string;
  exchangeRate?: string;
  lines: PostJournalLine[];
  createdBy?: string;
}

export interface PostJournalResult {
  entryId: number;
  entryNumber: string;
  replayed: boolean;
}

export interface ReverseJournalResult {
  reversalEntryId: number;
}
