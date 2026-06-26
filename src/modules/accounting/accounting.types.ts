export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

export interface BalanceSheetRow {
  accountId: number;
  code: string;
  name: string;
  accountType: AccountType;
  balance: string;
}

export interface VendorLedgerLine {
  date: string;
  entryId: number;
  entryNumber: string;
  sourceType: string;
  sourceEvent: string | null;
  description: string | null;
  billId: number | null;
  billNumber: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface CustomerLedgerLine {
  date: string;
  entryId: number;
  entryNumber: string;
  sourceType: string;
  sourceEvent: string | null;
  description: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface CustomerLedgerSummary {
  clientId: number;
  clientName: string;
  state: string | null;
  gstin: string | null;
  totalInvoiced: string;
  totalPaid: string;
  outstanding: string;
}

export interface CustomerLedger {
  summary: CustomerLedgerSummary;
  lines: CustomerLedgerLine[];
}

export interface CustomerOutstanding {
  clientId: number;
  clientName: string;
  state: string | null;
  gstin: string | null;
  invoiceCount: number;
  outstanding: string;
}

export interface AgedReceivablesRow {
  clientId: number;
  clientName: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d91_plus: string;
  total: string;
}

export interface AgedPayablesRow {
  vendorId: number;
  vendorName: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d91_plus: string;
  total: string;
}

export interface Gstr3BTaxBlock {
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export type Gstr1Section = "B2B" | "B2C";

export interface Gstr1RateBucket {
  gstRate: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  invoiceCount: number;
}

export interface Gstr1PlaceBucket {
  placeOfSupply: string | null;
  placeName: string | null;
  rates: Gstr1RateBucket[];
}

export interface Gstr1Section1 {
  section: Gstr1Section;
  places: Gstr1PlaceBucket[];
  totalTaxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalInvoices: number;
}

export interface Gstr1Report {
  from: string;
  to: string;
  b2b: Gstr1Section1;
  b2c: Gstr1Section1;
  grandTotal: {
    taxableValue: string;
    cgst: string;
    sgst: string;
    igst: string;
    invoices: number;
  };
}
