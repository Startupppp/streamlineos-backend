/**
 * D6 — every journal inventory posts, written down once.
 *
 * `InventoryAccountingBridge.postJournalEntry` skips honestly: when the
 * accounting module is not migrated, or when the tenant has no chart-of-accounts
 * row for a code the entry needs, the goods still move and no journal is
 * written. That is deliberate — a receipt is a physical fact and refusing to
 * record it because nobody has set up account 1300 puts the warehouse's records
 * further from the truth. The cost of that decision is a gap between stock and
 * the general ledger, and this table is what makes the gap countable instead of
 * invisible.
 *
 * `sourceType` is both `inv_stock_transactions.reference_type` (the stock engine
 * copies the command's `sourceType` onto every ledger row it writes) and
 * `journal_entries.source_type`, which is why the two sides join at all.
 *
 * Kept in sync by hand with the three call sites, because there is no third
 * place that knows both halves:
 *
 *   purchase-orders/lib/receipt-journal.ts   inv_grn / receive         1300 · 2000
 *   sales-orders/so-fulfillment.service.ts   inv_sales_order / ship    5000 · 1300
 *   sales-orders/so-lifecycle.service.ts     inv_sales_order / invoice 1200 · 4000
 *
 * The `invoice` entry is deliberately not a rule here: it books revenue off a
 * sales order and is not produced by a stock movement, so pairing it with one
 * would invent an expectation the engine never had.
 */
export interface GlPostingRule {
  /** `inv_stock_transactions.reference_type` and `journal_entries.source_type`. */
  sourceType: string;
  /** `journal_entries.source_event`. */
  sourceEvent: string;
  label: string;
  /** Every code the entry names. A missing one is why the bridge skipped. */
  accountCodes: readonly string[];
}

export const GL_POSTING_RULES: readonly GlPostingRule[] = [
  {
    sourceType: "inv_grn",
    sourceEvent: "receive",
    label: "Goods receipt",
    accountCodes: ["1300", "2000"],
  },
  {
    sourceType: "inv_sales_order",
    sourceEvent: "ship",
    label: "Cost of goods sold",
    accountCodes: ["5000", "1300"],
  },
  {
    // G5. Applying a landed-cost voucher restates what inventory is worth, so it
    // posts like a receipt does — and the recon report must expect it, or a
    // freight allocation of any size vanishes from the comparison and the report
    // says everything reconciles. This mirror test is what caught its absence.
    //
    // Three codes rather than two: the voucher credits the payable, debits
    // inventory for stock still on hand, and debits COGS for whatever has
    // already shipped, because value cannot be added to units that have left.
    sourceType: "inv_landed_cost",
    sourceEvent: "apply",
    label: "Landed cost applied",
    accountCodes: ["1300", "5000", "2000"],
  },
];

export const GL_RECON_STATUSES = [
  "MATCHED",
  "VALUE_MISMATCH",
  "MISSING_COA",
  "UNMATCHED",
  "ACCOUNTING_NOT_INSTALLED",
] as const;

export type GlReconStatus = (typeof GL_RECON_STATUSES)[number];
