import { UnprocessableEntityException } from "@nestjs/common";
import type { DbOrTx } from "../../../accounting/kernel/sequence.service";
import {
  InventoryAccountingBridge,
  minorUnitsToDecimal,
  toMinorUnits,
  type InventoryJournalLine,
} from "../../stock-engine/accounting-bridge";
import { isPositive } from "../../stock-engine/decimal";
import { type RevaluationPlan } from "./layer-revaluation";

/*
  TODO(INV-38, accounting decision): landed cost has no kernel document kind.

  `StockDocumentKind` has no landed-cost member, `gl_journal_source` has no
  landed-cost source, and `gl_system_tag` has no `landed_cost_clearing` role
  (0672 deliberately left it out until a landed-cost feature existed). Until
  accounting decides, the voucher posts through the generic
  `PostingCommandService.submit`, via `InventoryAccountingBridge`, as:

    source   stock_move, purpose `landed_cost`, keyed stock_move:{voucherId}:landed_cost
    Dr       inventory   the share that capitalised onto layers still on hand
    Dr       cogs        the share on units already issued
    Cr       ap_control  the whole charge

  Why these and not others. `stock_move` because this is a stock valuation
  event, and the `landed_cost` purpose keeps voucher ids out of every other
  stock document's key space. `purchase_bill` would put an inventory voucher id
  into AP's own source space. `ap_control` for the credit is the reasoning on
  `PAYABLE_ACCOUNT` below: nothing would ever drain a clearing account. The
  three roles are what the legacy entry named (INVENTORY_ASSET, INVENTORY_COGS
  and AP), translated one for one.

  What accounting has to settle:
    1. a document kind and source for landed cost, or confirm `stock_move`;
    2. `ap_control` versus a `landed_cost_clearing` role that AP drains;
    3. the kernel's stock-to-GL reconciliation (`StockGlReconciliationService`)
       counts every `stock_move` line on the inventory account, and a landed-cost
       debit has no stock movement behind it, so an applied voucher shows as an
       unexplained bridge difference of its capitalised share until (1) is
       decided.
*/

/** Inventory. The receipt already debited it; landed cost adds to it. */
const INVENTORY_ACCOUNT = "INVENTORY_ASSET";
/**
 * Cost of goods sold. Freight on units that have already been issued belongs
 * here and not in inventory: those units are gone, their sale is already booked
 * at the old cost, and the append-only ledger means that sale's COGS cannot be
 * restated. The difference lands in the period the carrier's invoice did.
 */
const COGS_ACCOUNT = "INVENTORY_COGS";
/**
 * Accounts payable, the same credit side the receipt itself uses.
 *
 * INV-38 asks for a landed-cost *clearing* account here and this is deliberately
 * not one, because there is nothing for it to clear. A clearing account earns
 * its place between two events — an accrual and the bill that settles it — and
 * this voucher is a single event: `inv_landed_cost_charges` carries the
 * carrier's `vendor_id` and `reference`, the status enum runs only
 * `DRAFT → APPLIED`, and there is no estimated-freight posting before it or
 * actualisation after it. Nothing in the accounting module's AP drains a
 * landed-cost balance, so no vendor bill would ever debit the other side.
 *
 * Crediting a clearing account today would therefore book a balance that grows
 * forever and that no process can ever drain — further from the truth than
 * crediting the payable the money is actually owed on, not closer. The kernel
 * offers no clearing role anyway; `AP` resolves to the book's `ap_control`.
 */
const PAYABLE_ACCOUNT = "AP";

/** The accounting seam. The service hands over its own injected bridge. */
export interface LandedCostJournalDeps {
  readonly accounting: InventoryAccountingBridge;
}

export interface LandedCostJournalMinor {
  capitalisedMinor: number;
  expensedMinor: number;
  payableMinor: number;
}

/**
 * The voucher's three figures in whole minor units, balanced by construction.
 *
 * The plan splits the charge at four decimals, and `assertNothingLost` already
 * proved that the two halves add back to it exactly. Rounding each half to
 * minor units independently can still leave the entry one minor unit out: a
 * split of 10.3350 and 5.6650 against 16.00 rounds to 10.34 + 5.67 = 16.01, and
 * the ledger would refuse the journal as unbalanced with a 500. So the payable
 * is the charge, the capitalised share is rounded, and the expensed share is
 * what remains. That puts any sub-cent residual in COGS, the period's cost,
 * rather than into a layer's carrying value.
 *
 * A remainder that differs from the plan's own expensed figure by more than
 * one minor unit is not rounding. The split did not add up, and the voucher is
 * refused rather than posted with a silent plug.
 */
export function landedCostJournalMinor(
  chargeTotal: string,
  plan: Pick<RevaluationPlan, "capitalisedTotal" | "expensedTotal">,
): LandedCostJournalMinor {
  const payableMinor = toMinorUnits(chargeTotal);
  const capitalisedMinor = isPositive(plan.capitalisedTotal)
    ? toMinorUnits(plan.capitalisedTotal)
    : 0;
  const expensedMinor = payableMinor - capitalisedMinor;
  const plannedExpensedMinor = isPositive(plan.expensedTotal)
    ? toMinorUnits(plan.expensedTotal)
    : 0;
  if (expensedMinor < 0 || Math.abs(expensedMinor - plannedExpensedMinor) > 1) {
    throw new UnprocessableEntityException(
      `Landed-cost split ${plan.capitalisedTotal} + ${plan.expensedTotal} does not reconcile ` +
        `to the charge ${chargeTotal} in whole minor units`,
    );
  }
  return { capitalisedMinor, expensedMinor, payableMinor };
}

/**
 * The accounting entry, posted inside the voucher's own transaction (`tx`) for
 * the same reason the receipt's is: stock and the general ledger can then never
 * disagree, and a deferred failure would have no idempotency claim of its own
 * once this one has committed.
 *
 * Three lines rather than two, because the two halves land in different places:
 * what capitalised is inventory, what could not is this period's cost of sales.
 * A zero line is omitted rather than posted, so the common case — the invoice
 * arriving before anything shipped — reads as the two-line entry it is.
 *
 * Fails closed, as every kernel-era post does. An organisation that never
 * enabled accounting is skipped (`BOOK_NOT_ENABLED`) and can still land a
 * freight cost on its stock. One that did enable it and lacks a role this entry
 * names, or whose current period is locked, has the whole apply refused and
 * rolled back, including the layer revaluation. The legacy bridge warned and
 * skipped instead.
 */
export async function postLandedCostJournal(
  deps: LandedCostJournalDeps,
  orgId: string,
  userId: string,
  voucherId: number,
  grnNumber: string,
  postingDate: string,
  chargeTotal: string,
  plan: RevaluationPlan,
  tx: DbOrTx,
): Promise<void> {
  if (!isPositive(chargeTotal)) return;

  const { capitalisedMinor, expensedMinor, payableMinor } = landedCostJournalMinor(
    chargeTotal,
    plan,
  );

  const lines: InventoryJournalLine[] = [];
  if (capitalisedMinor > 0) {
    lines.push({
      purpose: INVENTORY_ACCOUNT,
      debit: minorUnitsToDecimal(capitalisedMinor),
      description: `Landed cost capitalised - ${grnNumber}`,
    });
  }
  if (expensedMinor > 0) {
    lines.push({
      purpose: COGS_ACCOUNT,
      debit: minorUnitsToDecimal(expensedMinor),
      description: `Landed cost on goods already issued - ${grnNumber}`,
    });
  }
  lines.push({
    purpose: PAYABLE_ACCOUNT,
    credit: minorUnitsToDecimal(payableMinor),
    description: `Landed cost payable - ${grnNumber}`,
  });

  await deps.accounting.postJournalEntry(
    {
      orgId,
      createdBy: userId,
      entryDate: postingDate,
      description: `Landed cost applied: ${grnNumber}`,
      sourceType: "inv_landed_cost",
      sourceId: String(voucherId),
      sourceEvent: "landed_cost",
      lines,
    },
    tx,
  );
}
