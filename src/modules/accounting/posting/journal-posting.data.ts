import type { Db } from "../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DraftLine {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string | null;
}

/**
 * A line whose amounts are already exact ledger-scale decimal strings.
 *
 * `journal_lines.debit`/`credit` are `numeric(18,4)`, whose range runs past
 * 2^53/10^4 — the point beyond which an IEEE-754 double can no longer carry four
 * decimal places. Any path that reads amounts back out of the ledger and writes
 * them again (a reversal) must stay in text the whole way, or a posted entry can
 * become unreversible because its reconstructed debits no longer equal its
 * credits.
 */
export interface DraftDecimalLine {
  accountCode: string;
  debit: string;
  credit: string;
  description?: string | null;
}

export interface DraftEntry {
  orgId: string;
  entryDate: string;
  description?: string | null;
  createdByMembershipId?: number | null;
  sourceType: string;
  sourceId: string | null;
  sourceEvent: string | null;
  status?: "DRAFT" | "POSTED";
  createdBy: string;
  lines: DraftLine[];
}

export interface DraftDecimalEntry extends Omit<DraftEntry, "lines"> {
  lines: DraftDecimalLine[];
}

export interface PersistedEntry {
  id: number;
  entryNumber: string;
}

export interface PostInvoiceInput {
  orgId: string;
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  subtotal: number;
  discount: number;
  taxPool: number;
  total: number;
  createdBy: string;
}

export interface PostPaymentInput {
  orgId: string;
  paymentId: number;
  invoiceNumber: string;
  paymentDate: string;
  paymentMethod: string;
  amount: number;
  createdBy: string;
}

export interface PostPurchaseBillInput {
  orgId: string;
  billId: number;
  billNumber: string;
  billDate: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  subtotal: number;
  discount: number;
  taxPool: number;
  total: number;
  expenseAccountCode: string;
  createdBy: string;
}

export interface PostVendorPaymentInput {
  orgId: string;
  paymentId: number;
  billNumber: string;
  paymentDate: string;
  paymentMethod: string;
  amount: number;
  createdBy: string;
}

export interface SeedAccount {
  code: string;
  name: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
}

export const INVOICE_SOURCE_TYPE = "invoice";
export const INVOICE_SEND_SOURCE_EVENT = "send";

export const ACCOUNTS_PAYABLE = "2000";
export const INPUT_CGST = "1410";
export const INPUT_SGST = "1411";
export const INPUT_IGST = "1412";

export const DEFAULT_COA: ReadonlyArray<SeedAccount> = [
  { code: "1000", name: "Cash", accountType: "ASSET" },
  { code: "1100", name: "Bank Account", accountType: "ASSET" },
  { code: "1200", name: "Accounts Receivable", accountType: "ASSET" },
  { code: "1300", name: "Inventory", accountType: "ASSET" },
  { code: "1400", name: "Prepaid Expenses", accountType: "ASSET" },
  { code: "1410", name: "Input CGST", accountType: "ASSET" },
  { code: "1411", name: "Input SGST", accountType: "ASSET" },
  { code: "1412", name: "Input IGST", accountType: "ASSET" },
  { code: "1500", name: "Fixed Assets", accountType: "ASSET" },
  { code: "1510", name: "Office Equipment", accountType: "ASSET" },
  { code: "1520", name: "Furniture and Fixtures", accountType: "ASSET" },
  { code: "1530", name: "Vehicles", accountType: "ASSET" },
  { code: "1590", name: "Accumulated Depreciation", accountType: "ASSET" },
  { code: "1600", name: "Security Deposits", accountType: "ASSET" },
  { code: "2000", name: "Accounts Payable", accountType: "LIABILITY" },
  { code: "2100", name: "GST Payable", accountType: "LIABILITY" },
  { code: "2110", name: "Output CGST", accountType: "LIABILITY" },
  { code: "2111", name: "Output SGST", accountType: "LIABILITY" },
  { code: "2112", name: "Output IGST", accountType: "LIABILITY" },
  { code: "2200", name: "TDS Payable", accountType: "LIABILITY" },
  { code: "2300", name: "Salary Payable", accountType: "LIABILITY" },
  { code: "2400", name: "Bonus Payable", accountType: "LIABILITY" },
  { code: "2500", name: "Provident Fund Payable", accountType: "LIABILITY" },
  { code: "2600", name: "ESI Payable", accountType: "LIABILITY" },
  { code: "2700", name: "Loans Payable", accountType: "LIABILITY" },
  { code: "3000", name: "Owner's Equity", accountType: "EQUITY" },
  { code: "3100", name: "Retained Earnings", accountType: "EQUITY" },
  { code: "3200", name: "Drawings", accountType: "EQUITY" },
  { code: "4000", name: "Sales Revenue", accountType: "INCOME" },
  { code: "4100", name: "Service Revenue", accountType: "INCOME" },
  { code: "4200", name: "Subscription Revenue", accountType: "INCOME" },
  { code: "4300", name: "Interest Income", accountType: "INCOME" },
  { code: "4900", name: "Other Income", accountType: "INCOME" },
  { code: "5000", name: "Cost of Goods Sold", accountType: "EXPENSE" },
  { code: "5100", name: "Salaries Expense", accountType: "EXPENSE" },
  { code: "5110", name: "Bonus Expense", accountType: "EXPENSE" },
  { code: "5120", name: "PF Contribution Expense", accountType: "EXPENSE" },
  { code: "5200", name: "Rent Expense", accountType: "EXPENSE" },
  { code: "5300", name: "Utilities Expense", accountType: "EXPENSE" },
  { code: "5400", name: "Office Supplies", accountType: "EXPENSE" },
  { code: "5500", name: "Travel Expense", accountType: "EXPENSE" },
  { code: "5600", name: "Marketing Expense", accountType: "EXPENSE" },
  { code: "5700", name: "Professional Fees", accountType: "EXPENSE" },
  { code: "5800", name: "Software Subscriptions", accountType: "EXPENSE" },
  { code: "5850", name: "Internet and Communication", accountType: "EXPENSE" },
  { code: "5900", name: "Depreciation Expense", accountType: "EXPENSE" },
  { code: "5910", name: "Bank Charges", accountType: "EXPENSE" },
  { code: "5920", name: "Interest Expense", accountType: "EXPENSE" },
  { code: "5990", name: "Miscellaneous Expense", accountType: "EXPENSE" },
];
