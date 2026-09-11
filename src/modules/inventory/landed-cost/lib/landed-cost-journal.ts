import { UnprocessableEntityException } from "@nestjs/common";
import {
  InventoryAccountingBridge,
  type InventoryJournalLine,
} from "../../stock-engine/accounting-bridge";
import { cmpDec, isDecimalString, isPositive } from "../../stock-engine/decimal";
import { type RevaluationPlan } from "./layer-revaluation";

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
 * Accounts payable, the same credit side the receipt itself used.
 *
 * INV-38 asks for a landed-cost *clearing* account here and this is deliberately
 * not one, because there is nothing for it to clear. A clearing account earns
 * its place between two events — an accrual and the bill that settles it — and
 * this voucher is a single event: `inv_landed_cost_charges` carries the
 * carrier's `vendor_id` and `reference`, the status enum runs only
 * `DRAFT → APPLIED`, and there is no estimated-freight posting before it or
 * actualisation after it. Nothing in `modules/finance` or `modules/accounting`
 * mentions landed cost, so no vendor bill would ever debit the other side.
 *
 * Crediting a clearing account today would therefore book a balance that grows
 * forever and that no process can ever drain — further from the truth than
 * crediting the payable the money is actually owed on, not closer.
 *
 * INV-09 has since made inventory resolve its accounts through
 * `acc_system_account_map`, and `INVENTORY_LANDED_COST_CLEARING` is one of the
 * six purposes an admin can now map. This line still does not use it, for the
 * reason above: an admin pointing that purpose at a real clearing account would
 * get exactly the un-drainable balance the paragraph above refuses to create.
 * `AP` is the honest purpose for a credit that is a payable, and resolving
 * through it means an organisation's own AP account is honoured. The purpose
 * becomes usable here when INV-38's AP counterpart exists, and not before.
 */
const PAYABLE_ACCOUNT = "AP";

/**
 * The one place a landed-cost figure stops being a decimal string.
 *
 * `DraftLine.debit` and `.credit` are `number`, so something has to convert;
 * every caller of `persistJournalEntry` does, and widening a signature the whole
 * accounting module shares is not INV-38's to do. What is avoidable is
 * converting *silently* — the denylist bans `Number()` on money precisely
 * because it is the step where a figure can change with nothing saying so.
 *
 * So the conversion is checked rather than trusted. Four decimals are exact in a
 * double up to 2^53 ten-thousandths, a little over 900 billion, and every figure
 * here is bounded by one voucher's charge total, so the guard should never fire.
 * Above that ceiling the two sides of the entry round independently and the
 * ledger goes out by an amount `assertBalanced` may not catch, since it compares
 * at two decimals while these columns hold four. Refusing is the honest answer:
 * the entry cannot be written correctly, and an apply that fails loudly is worth
 * more than a month-end that will not explain itself.
 */
export function toJournalAmount(value: string): number {
  const asNumber = Number(value);
  // `toFixed` rather than a magnitude check, and `isDecimalString` before
  // `cmpDec`: above 1e21 `toFixed` returns exponent notation, which the decimal
  // parser cannot read and would raise a `SyntaxError` from inside the voucher's
  // transaction instead of this exception.
  const roundTripped = Number.isFinite(asNumber) ? asNumber.toFixed(4) : "";
  if (!isDecimalString(roundTripped) || cmpDec(roundTripped, value) !== 0) {
    throw new UnprocessableEntityException(
      `Landed-cost amount ${value} cannot be posted to the general ledger without loss of precision`,
    );
  }
  return asNumber;
}

/** The accounting seam. The service hands over its own injected bridge. */
export interface LandedCostJournalDeps {
  readonly accounting: InventoryAccountingBridge;
}

/**
 * The accounting entry, posted inside the voucher's own transaction for the
 * same reason the receipt's is: stock and the general ledger can then never
 * disagree, and a deferred failure would have no idempotency claim of its own
 * once this one has committed.
 *
 * Three lines rather than two, because the two halves land in different places:
 * what capitalised is inventory, what could not is this period's cost of sales.
 * A zero line is omitted rather than posted, so the common case — the invoice
 * arriving before anything shipped — reads as the two-line entry it is.
 *
 * `postJournalEntry` skips with a warning when accounting is not migrated or
 * the tenant has no chart of accounts. That property is inherited deliberately:
 * a warehouse that has never configured account 1300 must still be able to land
 * a freight cost on its stock. Both paths — the entry and the skip — are held
 * by `landed-cost.seeded-e2e-spec`, which asserts the rows in `journal_entries`
 * rather than only what `apply` returned.
 *
 * The credit is the payable and not a clearing account; see `PAYABLE_ACCOUNT`
 * for why, and for what INV-09 would have to build before it could be one.
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
): Promise<void> {
  if (!isPositive(chargeTotal)) return;

  const lines: InventoryJournalLine[] = [];
  if (isPositive(plan.capitalisedTotal)) {
    lines.push({
      purpose: INVENTORY_ACCOUNT,
      debit: toJournalAmount(plan.capitalisedTotal),
      credit: 0,
      description: `Landed cost capitalised - ${grnNumber}`,
    });
  }
  if (isPositive(plan.expensedTotal)) {
    lines.push({
      purpose: COGS_ACCOUNT,
      debit: toJournalAmount(plan.expensedTotal),
      credit: 0,
      description: `Landed cost on goods already issued - ${grnNumber}`,
    });
  }
  lines.push({
    purpose: PAYABLE_ACCOUNT,
    debit: 0,
    credit: toJournalAmount(chargeTotal),
    description: `Landed cost payable - ${grnNumber}`,
  });

  await deps.accounting.postJournalEntry({
    orgId,
    entryDate: postingDate,
    description: `Landed cost applied: ${grnNumber}`,
    sourceType: "inv_landed_cost",
    sourceId: String(voucherId),
    sourceEvent: "apply",
    status: "POSTED",
    createdBy: userId,
    lines,
  });
}
