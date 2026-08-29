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
 * own transaction.
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
 * The one *expected* failure is not handled here: `postJournalEntry` skips with
 * a warning when the accounting module is not migrated or the tenant has no
 * chart of accounts, so a warehouse that has never configured account 1300 still
 * receives goods. That property holds in or out of a transaction, and it is
 * written down at this call site because a reader of the receiving path would
 * otherwise have to go and find out whether posting stock can be blocked by an
 * unrelated module the tenant has not bought.
 */
export async function postReceiptJournal(
  bridge: InventoryAccountingBridge,
  orgId: string,
  userId: string,
  grn: JournalReceipt,
  po: JournalOrder,
  lines: ReadonlyArray<JournalLine>,
): Promise<void> {
  // Exact, not float. `quantity * parseFloat(unitCost)` is the arithmetic the
  // PRD forbids outright for money, and this figure is what lands on both sides
  // of a journal entry — a rounding error here is an unbalanced ledger.
  let totalValueDec = "0.0000";
  for (const line of lines) {
    if (line.qualityStatus !== "ACCEPTED") continue;
    const poLine = po.lines.find((l) => l.id === line.poLineId);
    if (!poLine) continue;
    totalValueDec = addDec(totalValueDec, mulDec(line.quantityReceived, poLine.unitCost));
  }
  if (!isPositive(totalValueDec)) return;

  const totalValue = Number(totalValueDec);
  await bridge.postJournalEntry({
    orgId,
    entryDate: grn.receivedDate,
    description: `Goods received: ${grn.grnNumber}`,
    sourceType: "inv_grn",
    sourceId: String(grn.id),
    sourceEvent: "receive",
    status: "POSTED",
    createdBy: userId,
    lines: [
      {
        credit: 0,
        debit: totalValue,
        accountCode: "1300",
        description: `Inventory received - ${grn.grnNumber}`,
      },
      {
        accountCode: "2000",
        debit: 0,
        credit: totalValue,
        description: `AP - PO ${po.poNumber}`,
      },
    ],
  });
}
