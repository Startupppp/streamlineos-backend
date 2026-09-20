/**
 * The ledger kernel's vocabulary — account types, period, fiscal-year and book
 * states, the journal source list and the system-tag roles.
 *
 * Split out of `gl-kernel.ts`, which re-exports every name here, so importing
 * from either file reaches the same enums.
 */
import { pgEnum } from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

/** Normal balance is derived from the type; contra types invert their parent. */
export const glAccountTypeEnum = pgEnum("gl_account_type", [
  "ASSET",
  "CONTRA_ASSET",
  "LIABILITY",
  "CONTRA_LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
]);

export const glPeriodStatusEnum = pgEnum("gl_period_status", ["OPEN", "LOCKED"]);

export const glFiscalYearStatusEnum = pgEnum("gl_fiscal_year_status", ["OPEN", "CLOSED"]);

export const glBookStatusEnum = pgEnum("gl_book_status", ["ACTIVE", "ARCHIVED"]);

/**
 * Source of a posting. Documents are sources; the kernel never invents one.
 * PRD 07 M3 fixes this list — adding a member is an accounting-side change only.
 */
export const glJournalSourceEnum = pgEnum("gl_journal_source", [
  "manual",
  "opening_balance",
  "sales_invoice",
  "credit_note",
  "receipt",
  "purchase_bill",
  "debit_note",
  "payment",
  "bank_fee",
  "bank_transfer",
  "payroll_run",
  "expense_claim",
  "billing_invoice",
  "withholding",
  "fx_reval",
  "depreciation",
  "stock_move",
  "period_close",
]);

/**
 * Stable roles documents resolve accounts by, so no document hardcodes a code.
 * Packs (PRD 12) tag their seeded chart against these.
 */
export const glSystemTagEnum = pgEnum("gl_system_tag", [
  "cash",
  "bank",
  "undeposited",
  "ar_control",
  "ap_control",
  /**
   * Goods received not invoiced. The receipt credits this; the bill debits it
   * and credits `ap_control`, so it nets to zero per PO line. Crediting AP
   * directly at receipt puts a balance in the control account for which no bill
   * exists, and the AP subledger cannot then agree with it (0672).
   */
  "grni",
  "sales",
  "other_income",
  "cogs",
  "opex",
  "salary",
  "equity_capital",
  "retained_earnings",
  "current_year_earnings",
  "fx_gain",
  "fx_loss",
  "rounding",
  // generic tax
  "vat_input",
  "vat_output",
  "sales_tax_payable",
  "wht_payable",
  // India GST pack
  "gst_input_cgst",
  "gst_input_sgst",
  "gst_input_igst",
  "gst_input_utgst",
  "gst_input_cess",
  "gst_output_cgst",
  "gst_output_sgst",
  "gst_output_igst",
  "gst_output_utgst",
  "gst_output_cess",
  // payment rails (PRD 14) — clearing only, never a bank
  "psp_clearing",
  "razorpay_clearing",
  "stripe_clearing",
  "payment_fees",
  // payroll hand-off (PRD 07)
  "net_pay_clearing",
  "statutory_payable",
  // reserved for PRD 15 so v2 does not migrate posted history
  "fixed_asset",
  "accum_depreciation",
  "depreciation_expense",
  "deferred_revenue",
  "inventory",
  /** Scrap, quality write-off, recall destruction: stock that left without a sale. */
  "inventory_write_off",
  /**
   * Cycle-count and physical-audit variance, both directions — a gain credits
   * it and a loss debits it, so the balance is the period's net adjustment cost
   * rather than two figures that must be added back to mean anything (0672).
   */
  "inventory_adjustment",
  "landed_cost",
]);

/* ----------------------------------------------------------------- types */

export type GlAccountType = (typeof glAccountTypeEnum.enumValues)[number];
export type GlSystemTag = (typeof glSystemTagEnum.enumValues)[number];
export type GlJournalSource = (typeof glJournalSourceEnum.enumValues)[number];
