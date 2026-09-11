import type { DbOrTx } from "../../../accounting/kernel/sequence.service";
import type { InventoryAccountingBridge } from "../../stock-engine/accounting-bridge";
import { addDec, mulDec, isPositive } from "../../stock-engine/decimal";

interface JournalReceipt {
  id: number;
  grnNumber: string;
  receivedDate: string;
}

interface JournalOrder {
  poNumber: string;
  lines: ReadonlyArray<{ id: number; unitCost: string }>;
}

interface JournalLine {
  poLineId: number;
  quantityReceived: string;
  qualityStatus: string;
}

/**
 * B1, item 5 — the accounting entry for a receipt, posted inside the receipt's
 * own transaction, which is passed in as `tx`.
 *
 * The alternative was `registerAfterCommit`, and the argument for deferring is
 * that a ledger failure must not destroy the record of a delivery that
 * physically happened. B1 itself removes that argument: by the time this runs
 * the receipt is already a durable document, so a rollback returns it to
 * COUNTING with every counted quantity intact and the operator posts again.
 * Nothing observed on the dock is lost. In exchange stock and the general ledger
 * can never disagree, and a deferred failure — which §4 forbids swallowing, and
 * which would have no idempotency claim of its own once the request's claim has
 * committed — cannot happen at all.
 *
 * What can refuse it, since the accounting rewrite. An organisation that never
 * enabled accounting is skipped (`BOOK_NOT_ENABLED`), so a warehouse without
 * the accounting module still receives goods. An organisation that DID enable
 * it and has no account tagged for a role this entry names, or whose period for
 * the receipt date is locked, has the post refused, and the receipt rolls back
 * with it. That is the kernel's fail-closed contract
 * (`docs/inventory-gl-contract.md` §4) and it replaces the legacy warn-and-skip,
 * which let goods move with no journal behind them.
 *
 * Keyed `stock_move:{grnId}:receive`, the same key the one-shot receive in
 * `grn-receive.service.ts` uses. Both mean "this GRN was posted", so one GRN
 * yields one receipt journal whichever path posted it.
 */
export async function postReceiptJournal(
  bridge: InventoryAccountingBridge,
  orgId: string,
  userId: string,
  grn: JournalReceipt,
  po: JournalOrder,
  lines: ReadonlyArray<JournalLine>,
  tx: DbOrTx,
): Promise<void> {
  // Exact, not float. `quantity * parseFloat(unitCost)` is the arithmetic the
  // PRD forbids outright for money, and this figure is what lands on both sides
  // of a journal entry — a rounding error here is an unbalanced ledger. The
  // bridge takes it to minor units once, so both sides round identically.
  let totalValueDec = "0.0000";
  for (const line of lines) {
    if (line.qualityStatus !== "ACCEPTED") continue;
    const poLine = po.lines.find((l) => l.id === line.poLineId);
    if (!poLine) continue;
    totalValueDec = addDec(totalValueDec, mulDec(line.quantityReceived, poLine.unitCost));
  }
  if (!isPositive(totalValueDec)) return;

  await bridge.postJournalEntry(
    {
      orgId,
      createdBy: userId,
      entryDate: grn.receivedDate,
      description: `Goods received: ${grn.grnNumber}`,
      sourceType: "inv_grn",
      sourceId: String(grn.id),
      sourceEvent: "receive",
      lines: [
        {
          purpose: "INVENTORY_ASSET",
          debit: totalValueDec,
          description: `Inventory received - ${grn.grnNumber}`,
        },
        {
          // Named GRNI because that is what the credit means on a receipt. It
          // resolves to `ap_control` for now; see `INVENTORY_PURPOSE_TAG` for
          // why, and for what has to change together before it can be `grni`.
          purpose: "INVENTORY_GRNI",
          credit: totalValueDec,
          description: `AP - PO ${po.poNumber}`,
        },
      ],
    },
    tx,
  );
}
