/**
 * Report labels as **data**, in one file.
 *
 * PRD 06 asks for a founder who has never read a balance sheet to understand
 * one, with the accountant's vocabulary one toggle away. That is a labelling
 * problem, not a reporting problem — the numbers are identical in both modes,
 * so the toggle can never change what the ledger says.
 *
 * Every report line carries a `labelKey`; the services resolve it once against
 * the requested mode. Nothing anywhere else in `reports/` may hardcode a
 * user-facing string, because the moment labels are scattered the two modes
 * drift and "one toggle away" stops being true.
 */

export type LabelMode = "founder" | "accountant";


export interface LabelPair {
  /** Plain English, for someone running a company rather than keeping books. */
  founder: string;
  /** The name an accountant, auditor or bank expects to see. */
  accountant: string;
}

/**
 * The catalog. Keys are namespaced `<kind>.<name>` so a reader can tell a
 * report title from a section heading from a single line without a lookup.
 */
export const REPORT_LABELS = {
  /* ------------------------------------------------------- report titles */
  "report.trial_balance": {
    founder: "Every account, checked",
    accountant: "Trial balance",
  },
  "report.profit_loss": {
    founder: "Did we make money?",
    accountant: "Profit and loss",
  },
  "report.balance_sheet": {
    founder: "What we own and what we owe",
    accountant: "Balance sheet",
  },
  "report.cash_flow": {
    founder: "Where the cash went",
    accountant: "Cash flow statement (indirect)",
  },
  "report.aging_ar": {
    founder: "What customers owe us",
    accountant: "Accounts receivable ageing",
  },
  "report.aging_ap": {
    founder: "What we owe suppliers",
    accountant: "Accounts payable ageing",
  },
  "report.tax_summary": {
    founder: "Tax we collected and tax we paid",
    accountant: "Tax summary",
  },

  /* ------------------------------------------------------------ sections */
  "section.income": { founder: "Money in", accountant: "Income" },
  "section.expense": { founder: "Money out", accountant: "Expenses" },
  "section.net_profit": { founder: "What's left", accountant: "Net profit" },
  "section.assets": { founder: "What we own", accountant: "Assets" },
  "section.liabilities": { founder: "What we owe", accountant: "Liabilities" },
  "section.equity": { founder: "The owners' share", accountant: "Equity" },
  "section.operating": {
    founder: "Cash from running the business",
    accountant: "Cash from operating activities",
  },
  "section.working_capital": {
    founder: "Money tied up in unpaid invoices and bills",
    accountant: "Movements in working capital",
  },
  "section.non_cash": {
    founder: "Costs that never left the bank",
    accountant: "Non-cash adjustments",
  },
  "section.unmodelled": {
    founder: "Other money in and out we do not explain yet",
    accountant: "Movements not modelled by the indirect method",
  },

  /* --------------------------------------------------------------- lines */
  "line.current_year_earnings": {
    founder: "Profit made so far this year",
    accountant: "Current year earnings",
  },
  "line.prior_year_earnings": {
    founder: "Profit kept from earlier years",
    accountant: "Retained earnings brought forward",
  },
  "line.net_income": {
    founder: "Profit for the period",
    accountant: "Net profit for the period",
  },
  "line.depreciation": {
    founder: "Wear and tear on things we own",
    accountant: "Depreciation add-back",
  },
  "line.ar_movement": {
    founder: "Change in what customers owe us",
    accountant: "Movement in trade receivables",
  },
  "line.ap_movement": {
    founder: "Change in what we owe suppliers",
    accountant: "Movement in trade payables",
  },
  "line.tax_movement": {
    founder: "Change in tax owed or reclaimable",
    accountant: "Movement in tax balances",
  },
  "line.other_movements": {
    founder: "Everything else that moved the bank balance",
    accountant: "Other movements (financing, investing, unclassified)",
  },
  "line.opening_cash": { founder: "Cash we started with", accountant: "Opening cash" },
  "line.closing_cash": { founder: "Cash we ended with", accountant: "Closing cash" },
  "line.net_movement": { founder: "Change in cash", accountant: "Net movement in cash" },
  "line.total_open": { founder: "Total still outstanding", accountant: "Total open items" },
  "line.control_balance": {
    founder: "What the books say the total should be",
    accountant: "Control account balance",
  },

  /* ------------------------------------------------------------- columns */
  "column.account": { founder: "Account", accountant: "Account" },
  "column.debit": { founder: "In", accountant: "Debit" },
  "column.credit": { founder: "Out", accountant: "Credit" },
  "column.amount": { founder: "Amount", accountant: "Amount" },
  "column.this_period": { founder: "This period", accountant: "Current period" },
  "column.last_period": { founder: "Last period", accountant: "Comparative period" },
  "column.change": { founder: "Change", accountant: "Variance" },
  "column.party": { founder: "Who", accountant: "Party" },
  "column.taxable": { founder: "Amount taxed", accountant: "Taxable value" },
  "column.tax": { founder: "Tax", accountant: "Tax amount" },

  /* ------------------------------------------------------- ageing buckets */
  "bucket.0_30": { founder: "Not overdue yet or barely", accountant: "0-30 days" },
  "bucket.31_60": { founder: "A month late", accountant: "31-60 days" },
  "bucket.61_90": { founder: "Two months late", accountant: "61-90 days" },
  "bucket.91_plus": { founder: "Three months late or worse", accountant: "91+ days" },

  /* -------------------------------------------------------- account types */
  "account_type.ASSET": { founder: "Something we own", accountant: "Asset" },
  "account_type.CONTRA_ASSET": {
    founder: "Reduces something we own",
    accountant: "Contra asset",
  },
  "account_type.LIABILITY": { founder: "Something we owe", accountant: "Liability" },
  "account_type.CONTRA_LIABILITY": {
    founder: "Reduces something we owe",
    accountant: "Contra liability",
  },
  "account_type.EQUITY": { founder: "The owners' share", accountant: "Equity" },
  "account_type.INCOME": { founder: "Money in", accountant: "Income" },
  "account_type.EXPENSE": { founder: "Money out", accountant: "Expense" },

  /* --------------------------------------------------------- tax gl roles */
  "tax_role.output_payable": {
    founder: "Tax we charged customers",
    accountant: "Output tax payable",
  },
  "tax_role.input_recoverable": {
    founder: "Tax we paid and can claim back",
    accountant: "Input tax recoverable",
  },
  "tax_role.reverse_charge_output": {
    founder: "Tax we owe on someone else's behalf",
    accountant: "Reverse charge output",
  },
  "tax_role.reverse_charge_input": {
    founder: "Tax we can claim back on reverse charge",
    accountant: "Reverse charge input",
  },
  "tax_role.blocked_input": {
    founder: "Tax we paid and cannot claim back",
    accountant: "Blocked input tax",
  },
  "tax_role.withheld": {
    founder: "Tax held back from a payment",
    accountant: "Withholding tax",
  },
} as const satisfies Record<string, LabelPair>;

export type ReportLabelKey = keyof typeof REPORT_LABELS;

/** Both wordings for a key, so a UI can show one and tooltip the other. */
export function labelPair(key: ReportLabelKey): LabelPair {
  return REPORT_LABELS[key];
}

/** The wording for the requested mode. */
export function label(key: ReportLabelKey, mode: LabelMode): string {
  return REPORT_LABELS[key][mode];
}

/**
 * Label an account type. Typed against the catalog rather than string-built, so
 * a new `gl_account_type` member fails the build here instead of rendering
 * `undefined` in a report.
 */
export function accountTypeLabelKey(
  accountType:
    | "ASSET"
    | "CONTRA_ASSET"
    | "LIABILITY"
    | "CONTRA_LIABILITY"
    | "EQUITY"
    | "INCOME"
    | "EXPENSE",
): ReportLabelKey {
  return `account_type.${accountType}` as const;
}

export function taxRoleLabelKey(
  glRole:
    | "output_payable"
    | "input_recoverable"
    | "reverse_charge_output"
    | "reverse_charge_input"
    | "blocked_input"
    | "withheld",
): ReportLabelKey {
  return `tax_role.${glRole}` as const;
}
