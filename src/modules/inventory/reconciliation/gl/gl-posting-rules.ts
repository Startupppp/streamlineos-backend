import type { GlSystemTag } from "../../../../db/schema";
import {
  INVENTORY_PURPOSE_TAG,
  type InventoryAccountCodes,
  type InventoryJournalPurpose,
} from "../../stock-engine/accounting-bridge";

/**
 * D6 — every journal inventory posts off a stock document, written down once,
 * in the accounting kernel's terms.
 *
 * Each rule says which stock movements (`inv_stock_transactions.reference_type`)
 * a journal values, and how to find that journal in the ledger. Every
 * inventory journal is `source_type = 'stock_move'` with the idempotency key
 * `stock_move:{sourceId}:{sourceEvent}`, so `sourceEvent` here IS the posting
 * purpose. The report matches on the key, which is unique per book. It does not
 * match on `source_id` alone, because receipts, shipments, landed-cost vouchers
 * and the seven stock-bridge document kinds draw ids from different tables and
 * collide on it.
 *
 * Kept in sync by hand with the call sites, because no third place knows both
 * halves (`gl-posting-rules.spec.ts` holds the mirror):
 *
 *   purchase-orders/lib/receipt-journal.ts   inv_grn / receive              inventory · ap_control  (via InventoryAccountingBridge)
 *   purchase-orders/grn-receive.service.ts   inv_grn / receive              inventory · ap_control  (PostingCommandService)
 *   sales-orders/so-fulfillment.service.ts   inv_sales_order / ship         cogs · inventory        (PostingCommandService, keyed on the SHIPMENT)
 *   landed-cost/lib/landed-cost-journal.ts   inv_landed_cost / landed_cost  inventory · cogs · ap_control (via InventoryAccountingBridge)
 *
 * The sales-order invoice is deliberately not a rule. It books revenue off a
 * sales order (`sales_invoice:{invoiceId}:post`) and no stock movement produces
 * it. Adjustments, transfers, counts, quality scrap and returns are not rules
 * either: `StockMovementBridgeService` posts them per document kind, and the
 * accounting module's unposted-movements report reconciles them there. The
 * report lists them separately and does not run a second copy of that
 * reconciliation.
 *
 * INV-09: the expectation is stated in purposes, the same vocabulary posting
 * uses. `INVENTORY_PURPOSE_TAG` turns a purpose into a role, and
 * `resolveGlPostingRules` turns the roles into this organisation's account
 * codes, read through the same tags posting resolves.
 */
export interface GlPostingRule {
  /** `inv_stock_transactions.reference_type` of the movements this journal values. */
  sourceType: string;
  /** The kernel posting purpose: the last segment of `stock_move:{id}:{purpose}`. */
  sourceEvent: string;
  label: string;
  /**
   * How the journal's source id relates to the movement's reference id.
   * `reference`: they are the same id (a receipt journal is keyed on the GRN the
   * movements reference). `shipment`: the journal is keyed on a shipment of the
   * sales order the movements reference, and there can be several.
   */
  keyedOn: "reference" | "shipment";
  /** The purposes the entry names, in the vocabulary posting uses. */
  accountPurposes: readonly InventoryJournalPurpose[];
}

/** A rule against one organisation's book. */
export interface ResolvedGlPostingRule extends GlPostingRule {
  /** The roles the entry's accounts resolve through. */
  accountTags: readonly GlSystemTag[];
  /** Codes of the accounts filling those roles in this organisation's book now. */
  accountCodes: readonly string[];
  /**
   * Roles the entry names that no active account in the book fills. A post that
   * needs one is refused with `UNKNOWN_ACCOUNT_TAG`, so a movement with no
   * journal and a missing role reads `MISSING_COA`: the remedy is to tag an
   * account with the role.
   */
  missingAccountTags: readonly GlSystemTag[];
}

/** The roles a set of purposes resolves to, deduplicated, in purpose order. */
export function accountTagsOf(purposes: readonly InventoryJournalPurpose[]): GlSystemTag[] {
  return [...new Set(purposes.map((purpose) => INVENTORY_PURPOSE_TAG[purpose]))];
}

/**
 * The rules against this organisation's chart.
 *
 * Takes the resolved codes rather than the org id, so the caller resolves once
 * and both the SQL and the payload are built from the same answer. A second
 * resolution could disagree with the first if an account were re-tagged in
 * between, and a report whose expectation table and whose query disagree is
 * worse than either.
 */
export function resolveGlPostingRules(
  codes: InventoryAccountCodes,
): readonly ResolvedGlPostingRule[] {
  return GL_POSTING_RULES.map((rule) => {
    const accountCodes = [
      ...new Set(
        rule.accountPurposes
          .map((purpose) => codes[purpose])
          .filter((code): code is string => code !== null),
      ),
    ];
    const missingAccountTags = accountTagsOf(
      rule.accountPurposes.filter((purpose) => codes[purpose] === null),
    );
    return {
      ...rule,
      accountTags: accountTagsOf(rule.accountPurposes),
      accountCodes,
      missingAccountTags,
    };
  });
}

export const GL_POSTING_RULES: readonly GlPostingRule[] = [
  {
    sourceType: "inv_grn",
    sourceEvent: "receive",
    label: "Goods receipt",
    keyedOn: "reference",
    accountPurposes: ["INVENTORY_ASSET", "INVENTORY_GRNI"],
  },
  {
    // Keyed on the shipment, while the movements reference the sales order. A
    // partially shipped order has several COGS journals, and the group is the
    // whole order, so the report sums every one of them.
    sourceType: "inv_sales_order",
    sourceEvent: "ship",
    label: "Cost of goods sold",
    keyedOn: "shipment",
    accountPurposes: ["INVENTORY_COGS", "INVENTORY_ASSET"],
  },
  {
    // G5. Applying a landed-cost voucher restates what inventory is worth. It
    // moves no stock, so it can never form a movement group; it reaches this
    // report only through the orphan read, which is where the legacy report
    // showed it too. Three roles: the voucher credits the payable, debits
    // inventory for stock still on hand, and debits COGS for what has already
    // shipped.
    sourceType: "inv_landed_cost",
    sourceEvent: "landed_cost",
    label: "Landed cost applied",
    keyedOn: "reference",
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
