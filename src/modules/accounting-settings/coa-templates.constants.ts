export interface CoaTemplateAccount {
  code: string;
  name: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normalBalance?: "DEBIT" | "CREDIT";
  isSystem?: boolean;
  description?: string;
}

export interface CoaTemplate {
  key: string;
  label: string;
  country: string | null;
  accounts: CoaTemplateAccount[];
}

const IN_STANDARD_ACCOUNTS: CoaTemplateAccount[] = [
  { code: "1000", name: "Cash", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1100", name: "Bank Account", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1200", name: "Accounts Receivable", accountType: "ASSET", normalBalance: "DEBIT", isSystem: true },
  { code: "1300", name: "Inventory", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1400", name: "Prepaid Expenses", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1410", name: "Input CGST", accountType: "ASSET", normalBalance: "DEBIT", isSystem: true },
  { code: "1411", name: "Input SGST", accountType: "ASSET", normalBalance: "DEBIT", isSystem: true },
  { code: "1412", name: "Input IGST", accountType: "ASSET", normalBalance: "DEBIT", isSystem: true },
  { code: "1500", name: "Fixed Assets", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1510", name: "Office Equipment", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1520", name: "Furniture and Fixtures", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1530", name: "Vehicles", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1590", name: "Accumulated Depreciation", accountType: "ASSET", normalBalance: "CREDIT", isSystem: true },
  { code: "1600", name: "Security Deposits", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "2000", name: "Accounts Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2100", name: "GST Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2110", name: "Output CGST", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2111", name: "Output SGST", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2112", name: "Output IGST", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2200", name: "TDS Payable", accountType: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2300", name: "Salary Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2400", name: "Bonus Payable", accountType: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2500", name: "Provident Fund Payable", accountType: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2600", name: "ESI Payable", accountType: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2700", name: "Loans Payable", accountType: "LIABILITY", normalBalance: "CREDIT" },
  { code: "3000", name: "Owner's Equity", accountType: "EQUITY", normalBalance: "CREDIT", isSystem: true },
  { code: "3100", name: "Retained Earnings", accountType: "EQUITY", normalBalance: "CREDIT", isSystem: true },
  { code: "3200", name: "Drawings", accountType: "EQUITY", normalBalance: "DEBIT" },
  { code: "4000", name: "Sales Revenue", accountType: "INCOME", normalBalance: "CREDIT", isSystem: true },
  { code: "4100", name: "Service Revenue", accountType: "INCOME", normalBalance: "CREDIT" },
  { code: "4200", name: "Subscription Revenue", accountType: "INCOME", normalBalance: "CREDIT" },
  { code: "4300", name: "Interest Income", accountType: "INCOME", normalBalance: "CREDIT" },
  { code: "4900", name: "Other Income", accountType: "INCOME", normalBalance: "CREDIT" },
  { code: "5000", name: "Cost of Goods Sold", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5100", name: "Salaries Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5110", name: "Bonus Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5120", name: "PF Contribution Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5200", name: "Rent Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5300", name: "Utilities Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5400", name: "Office Supplies", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5500", name: "Travel Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5600", name: "Marketing Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5700", name: "Professional Fees", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5800", name: "Software Subscriptions", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5850", name: "Internet and Communication", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5900", name: "Depreciation Expense", accountType: "EXPENSE", normalBalance: "DEBIT", isSystem: true },
  { code: "5910", name: "Bank Charges", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5920", name: "Interest Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5990", name: "Miscellaneous Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
];

const GLOBAL_MINIMAL_ACCOUNTS: CoaTemplateAccount[] = [
  { code: "1000", name: "Cash", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1100", name: "Bank Account", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1200", name: "Accounts Receivable", accountType: "ASSET", normalBalance: "DEBIT", isSystem: true },
  { code: "1500", name: "Fixed Assets", accountType: "ASSET", normalBalance: "DEBIT" },
  { code: "1590", name: "Accumulated Depreciation", accountType: "ASSET", normalBalance: "CREDIT", isSystem: true },
  { code: "2000", name: "Accounts Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2100", name: "Tax Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "2300", name: "Payroll Payable", accountType: "LIABILITY", normalBalance: "CREDIT", isSystem: true },
  { code: "3000", name: "Owner's Equity", accountType: "EQUITY", normalBalance: "CREDIT", isSystem: true },
  { code: "3100", name: "Retained Earnings", accountType: "EQUITY", normalBalance: "CREDIT", isSystem: true },
  { code: "4000", name: "Revenue", accountType: "INCOME", normalBalance: "CREDIT", isSystem: true },
  { code: "4900", name: "Other Income", accountType: "INCOME", normalBalance: "CREDIT" },
  { code: "5000", name: "Cost of Goods Sold", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5100", name: "Salaries Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5900", name: "Depreciation Expense", accountType: "EXPENSE", normalBalance: "DEBIT", isSystem: true },
  { code: "5990", name: "Miscellaneous Expense", accountType: "EXPENSE", normalBalance: "DEBIT" },
];

export const COA_TEMPLATES: CoaTemplate[] = [
  {
    key: "in_standard",
    label: "India Standard (50 accounts)",
    country: "IN",
    accounts: IN_STANDARD_ACCOUNTS,
  },
  {
    key: "global_minimal",
    label: "Global Minimal (16 accounts)",
    country: null,
    accounts: GLOBAL_MINIMAL_ACCOUNTS,
  },
];
