import type {
  InventoryAccountCodes,
  InventoryJournalPurpose,
} from "../../stock-engine/accounting-bridge";

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
 * Kept in sync by hand with the call sites, because there is no third place
 * that knows both halves:
 *
 *   purchase-orders/lib/receipt-journal.ts   inv_grn / receive         ASSET · GRNI
 *   purchase-orders/grn-receive.service.ts   inv_grn / receive         ASSET · GRNI
 *   sales-orders/so-fulfillment.service.ts   inv_sales_order / ship    COGS · ASSET
 *   sales-orders/so-lifecycle.service.ts     inv_sales_order / invoice AR · SALES_INCOME
 *   landed-cost/landed-cost-apply.service.ts inv_landed_cost / apply   ASSET · COGS · AP
 *
 * The `invoice` entry is deliberately not a rule here: it books revenue off a
 * sales order and is not produced by a stock movement, so pairing it with one
 * would invent an expectation the engine never had.
 *
 * INV-09 — the expectation is stated in **purposes**, and resolved to codes per
 * organisation by `resolveGlPostingRules` at report time.
 *
 * This is the coupling that makes the rest of INV-09 safe. Posting resolves
 * `INVENTORY_ASSET` through `acc_system_account_map`; if this table kept the
 * literal 1300, then the first tenant to map INVENTORY_ASSET to anything else
 * would see every goods receipt reported MISSING_COA — the report claiming the
 * ledger is broken because the report, not the ledger, was reading the wrong
 * account. Both sides now resolve through the same call, so the report is right
 * for a mapped organisation for the same reason it was right for an unmapped one.
 */
export interface GlPostingRule {
  /** `inv_stock_transactions.reference_type` and `journal_entries.source_type`. */
  sourceType: string;
  /** `journal_entries.source_event`. */
  sourceEvent: string;
  label: string;
  /**
   * Every system-account purpose the entry names. A code the tenant has not
   * created is why the bridge skipped, and `resolveGlPostingRules` is what turns
   * these into that tenant's codes.
   */
  accountPurposes: readonly InventoryJournalPurpose[];
}

/** A rule against one organisation's chart of accounts. */
export interface ResolvedGlPostingRule extends GlPostingRule {
  /** Every code the entry names, for this organisation. */
  accountCodes: readonly string[];
}

/**
 * The rules as this organisation's account codes.
 *
 * Takes the resolved map rather than the org id, so the caller resolves once and
 * both the SQL and the payload it returns are built from the same answer — a
 * second resolution could disagree with the first if an admin saved the settings
 * screen in between, and a report whose expectation table and whose query
 * disagree is worse than either.
 */
export function resolveGlPostingRules(
  codes: InventoryAccountCodes,
): readonly ResolvedGlPostingRule[] {
  return GL_POSTING_RULES.map((rule) => ({
    ...rule,
    accountCodes: [...new Set(rule.accountPurposes.map((purpose) => codes[purpose]))],
  }));
}

export const GL_POSTING_RULES: readonly GlPostingRule[] = [
  {
    sourceType: "inv_grn",
    sourceEvent: "receive",
    label: "Goods receipt",
    accountPurposes: ["INVENTORY_ASSET", "INVENTORY_GRNI"],
  },
  {
    sourceType: "inv_sales_order",
    sourceEvent: "ship",
    label: "Cost of goods sold",
    accountPurposes: ["INVENTORY_COGS", "INVENTORY_ASSET"],
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
    accountPurposes: ["INVENTORY_ASSET", "INVENTORY_COGS", "AP"],
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
