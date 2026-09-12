import type { CoaTemplateAccount } from "./pack.types";

/**
 * The chart every pack starts from. Tax accounts are *not* here — a pack adds
 * its own (India needs six GST accounts, the US needs one sales-tax payable),
 * which is the whole reason tax is a plugin and not an `if (country === 'IN')`.
 *
 * Codes follow the conventional decimal blocks so an accountant recognises the
 * shape on sight: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income,
 * 5xxx expenses.
 */
export const BASE_CHART_OF_ACCOUNTS: readonly CoaTemplateAccount[] = Object.freeze([
  /* ------------------------------------------------------------- assets */
  { code: "1000", name: "Assets", type: "ASSET", isHeader: true },

  { code: "1010", name: "Cash on hand", type: "ASSET", parentCode: "1000", isCash: true, systemTag: "cash" },
  { code: "1020", name: "Bank account", type: "ASSET", parentCode: "1000", isCash: true, systemTag: "bank" },
  {
    code: "1030",
    name: "Undeposited funds",
    type: "ASSET",
    parentCode: "1000",
    systemTag: "undeposited",
    description: "Money received but not yet in the bank",
  },
  /**
   * Money a payment processor has captured but not yet settled to the bank
   * (PRD 14 M1). Named per provider rather than pooled, because a settlement
   * batch reconciles against one provider's clearing balance — a shared
   * account would make "did Razorpay pay us what it owed?" unanswerable.
   */
  {
    code: "1040",
    name: "Payment gateway clearing",
    type: "ASSET",
    parentCode: "1000",
    systemTag: "psp_clearing",
    description: "Captured by a processor, not yet settled to the bank",
  },
  {
    code: "1041",
    name: "Razorpay clearing",
    type: "ASSET",
    parentCode: "1000",
    systemTag: "razorpay_clearing",
    description: "Captured by Razorpay, awaiting settlement",
  },
  {
    code: "1042",
    name: "Stripe clearing",
    type: "ASSET",
    parentCode: "1000",
    systemTag: "stripe_clearing",
    description: "Captured by Stripe, awaiting settlement",
  },

  {
    code: "1100",
    name: "Accounts receivable",
    type: "ASSET",
    parentCode: "1000",
    systemTag: "ar_control",
    description: "Control account — moved only by AR documents",
  },

  { code: "1300", name: "Inventory", type: "ASSET", parentCode: "1000", systemTag: "inventory" },

  { code: "1500", name: "Fixed assets", type: "ASSET", parentCode: "1000", systemTag: "fixed_asset" },
  {
    code: "1590",
    name: "Accumulated depreciation",
    type: "CONTRA_ASSET",
    parentCode: "1000",
    systemTag: "accum_depreciation",
  },

  /* -------------------------------------------------------- liabilities */
  { code: "2000", name: "Liabilities", type: "LIABILITY", isHeader: true },

  {
    code: "2100",
    name: "Accounts payable",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "ap_control",
    description: "Control account — moved only by AP documents",
  },

  {
    code: "2110",
    name: "Goods received not invoiced",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "grni",
    description: "A goods receipt credits this; the supplier bill debits it and credits AP",
  },

  {
    code: "2300",
    name: "Withholding tax payable",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "wht_payable",
  },
  {
    code: "2400",
    name: "Net pay clearing",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "net_pay_clearing",
    description: "Payroll posts here; the bank file clears it",
  },
  {
    code: "2410",
    name: "Statutory payable",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "statutory_payable",
  },
  {
    code: "2500",
    name: "Deferred revenue",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "deferred_revenue",
  },

  /* ------------------------------------------------------------- equity */
  { code: "3000", name: "Equity", type: "EQUITY", isHeader: true },
  { code: "3100", name: "Share capital", type: "EQUITY", parentCode: "3000", systemTag: "equity_capital" },
  {
    code: "3200",
    name: "Retained earnings",
    type: "EQUITY",
    parentCode: "3000",
    systemTag: "retained_earnings",
  },
  {
    code: "3300",
    name: "Current year earnings",
    type: "EQUITY",
    parentCode: "3000",
    systemTag: "current_year_earnings",
    description: "Computed by the balance sheet; not posted to directly",
  },

  /* ------------------------------------------------------------- income */
  { code: "4000", name: "Income", type: "INCOME", isHeader: true },
  { code: "4100", name: "Sales", type: "INCOME", parentCode: "4000", systemTag: "sales" },
  { code: "4900", name: "Other income", type: "INCOME", parentCode: "4000", systemTag: "other_income" },
  { code: "4910", name: "Foreign exchange gain", type: "INCOME", parentCode: "4000", systemTag: "fx_gain" },

  /* ----------------------------------------------------------- expenses */
  { code: "5000", name: "Expenses", type: "EXPENSE", isHeader: true },
  { code: "5100", name: "Cost of sales", type: "EXPENSE", parentCode: "5000", systemTag: "cogs" },
  {
    code: "5110",
    name: "Inventory write-off",
    type: "EXPENSE",
    parentCode: "5000",
    systemTag: "inventory_write_off",
    description: "Scrap, quality write-off, recall destruction — stock that left without a sale",
  },
  {
    code: "5120",
    name: "Inventory adjustment",
    type: "EXPENSE",
    parentCode: "5000",
    systemTag: "inventory_adjustment",
    description: "Count variance both ways: a loss debits it, a gain credits it, so the balance is the net",
  },
  { code: "5200", name: "Salaries and wages", type: "EXPENSE", parentCode: "5000", systemTag: "salary" },
  { code: "5300", name: "Operating expenses", type: "EXPENSE", parentCode: "5000", systemTag: "opex" },
  { code: "5310", name: "Rent", type: "EXPENSE", parentCode: "5000" },
  { code: "5320", name: "Software subscriptions", type: "EXPENSE", parentCode: "5000" },
  { code: "5330", name: "Professional fees", type: "EXPENSE", parentCode: "5000" },
  { code: "5340", name: "Travel", type: "EXPENSE", parentCode: "5000" },
  { code: "5350", name: "Marketing", type: "EXPENSE", parentCode: "5000" },
  {
    code: "5900",
    name: "Depreciation",
    type: "EXPENSE",
    parentCode: "5000",
    systemTag: "depreciation_expense",
  },
  {
    code: "5910",
    name: "Payment processing fees",
    type: "EXPENSE",
    parentCode: "5000",
    systemTag: "payment_fees",
  },
  { code: "5920", name: "Foreign exchange loss", type: "EXPENSE", parentCode: "5000", systemTag: "fx_loss" },
  {
    code: "5990",
    name: "Rounding difference",
    type: "EXPENSE",
    parentCode: "5000",
    systemTag: "rounding",
    description: "Absorbs pack-mandated rounding so journals still balance at zero tolerance",
  },
]);

/** India GST needs input and output legs per component. */
export const IN_GST_ACCOUNTS: readonly CoaTemplateAccount[] = Object.freeze([
  { code: "1200", name: "Input CGST", type: "ASSET", parentCode: "1000", systemTag: "gst_input_cgst" },
  { code: "1210", name: "Input SGST", type: "ASSET", parentCode: "1000", systemTag: "gst_input_sgst" },
  { code: "1220", name: "Input IGST", type: "ASSET", parentCode: "1000", systemTag: "gst_input_igst" },
  { code: "1230", name: "Input UTGST", type: "ASSET", parentCode: "1000", systemTag: "gst_input_utgst" },
  { code: "1240", name: "Input GST cess", type: "ASSET", parentCode: "1000", systemTag: "gst_input_cess" },

  { code: "2200", name: "Output CGST", type: "LIABILITY", parentCode: "2000", systemTag: "gst_output_cgst" },
  { code: "2210", name: "Output SGST", type: "LIABILITY", parentCode: "2000", systemTag: "gst_output_sgst" },
  { code: "2220", name: "Output IGST", type: "LIABILITY", parentCode: "2000", systemTag: "gst_output_igst" },
  { code: "2230", name: "Output UTGST", type: "LIABILITY", parentCode: "2000", systemTag: "gst_output_utgst" },
  { code: "2240", name: "Output GST cess", type: "LIABILITY", parentCode: "2000", systemTag: "gst_output_cess" },
]);

/** A single-rate VAT regime needs one recoverable and one payable account. */
export const GENERIC_VAT_ACCOUNTS: readonly CoaTemplateAccount[] = Object.freeze([
  { code: "1200", name: "VAT recoverable", type: "ASSET", parentCode: "1000", systemTag: "vat_input" },
  { code: "2200", name: "VAT payable", type: "LIABILITY", parentCode: "2000", systemTag: "vat_output" },
]);

/** US sales tax is collected, never recovered — one payable account. */
export const US_SALES_TAX_ACCOUNTS: readonly CoaTemplateAccount[] = Object.freeze([
  {
    code: "2200",
    name: "Sales tax payable",
    type: "LIABILITY",
    parentCode: "2000",
    systemTag: "sales_tax_payable",
  },
]);

/** Compose a pack's chart from the shared base plus its tax accounts. */
export function chartWith(
  ...taxAccountSets: ReadonlyArray<readonly CoaTemplateAccount[]>
): readonly CoaTemplateAccount[] {
  return Object.freeze([...BASE_CHART_OF_ACCOUNTS, ...taxAccountSets.flat()]);
}
