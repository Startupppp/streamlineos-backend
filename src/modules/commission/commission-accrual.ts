import { ruleFor, versionInForceAt, type CommissionPlan } from "./commission-plan";

/**
 * Commission as a ledger of entries, each traceable to the deal that produced it.
 *
 * Phase 5, tickets 05 and 06. Two decisions shape everything here.
 *
 * **An entry stores its inputs, not its answer.** `basisMinor`, `rateBps` and
 * `splitBps` are what the entry carries; the money is derived. That is what makes
 * ticket 05's "decomposes to its contributing deals" true by construction rather
 * than by a reporting query that happens to group correctly — and it is what lets
 * a dispute be answered by showing the working instead of rebuilding it in a
 * spreadsheet.
 *
 * **Rounding happens once, at payout, over the whole set.** A 40% split of a 15%
 * commission is a percentage of a percentage, and rounding each entry as it is
 * created loses a minor unit per entry in a way nobody can reconstruct three
 * months later. Every entry is exact until somebody is paid:
 *
 *     payout = round( Σ (basisMinor × rateBps × splitBps) / 100_000_000 )
 *
 * The division is done once on an integer numerator, so the drift a float would
 * accumulate never exists. The rule is stated here because ticket 04 asks for it
 * to be stated rather than discovered.
 */
export const BPS = 10_000;

export type AccrualReason = "earned" | "clawback";

export interface AccrualEntry {
  readonly entryId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly dealId: string;
  readonly planId: string;
  /** The plan version this was earned under, so a payout reproduces. */
  readonly planVersion: number;
  readonly reason: AccrualReason;
  /** The deal value the rate applied to, in minor units. */
  readonly basisMinor: number;
  readonly rateBps: number;
  /** This person's share of the deal, in basis points. A sole owner is 10000. */
  readonly splitBps: number;
  readonly occurredAt: Date;
  /** Set on a clawback: the entry being reversed. */
  readonly reversesEntryId?: string;
  readonly note?: string;
}

/** A person's share of a deal. Ticket 04: a relationship on the deal, not a parallel record. */
export interface DealSplit {
  readonly personId: string;
  readonly splitBps: number;
}

export interface DealForAccrual {
  readonly dealId: string;
  readonly organizationId: string;
  readonly stage: string;
  readonly valueMinor: number;
  readonly occurredAt: Date;
  readonly splits: readonly DealSplit[];
}

export class CommissionAccrualError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionAccrualError";
  }
}

/**
 * The exact, unrounded contribution of one entry, as an integer numerator.
 *
 * Kept as a numerator over `BPS * BPS` rather than a number so that summing is
 * exact. A clawback contributes a negative numerator, which is why a reversal
 * needs no separate arithmetic — see `clawbackFor`.
 */
function numeratorOf(entry: AccrualEntry): number {
  const sign = entry.reason === "clawback" ? -1 : 1;
  return sign * entry.basisMinor * entry.rateBps * entry.splitBps;
}

/**
 * What somebody is owed, rounded once.
 *
 * Half-up on the absolute value, so a clawback of 2.5 minor units and an earning
 * of 2.5 round to the same magnitude. Rounding toward zero on one and away on the
 * other is how a person who earns and loses the same deal ends up a unit out.
 */
export function payoutMinor(entries: readonly AccrualEntry[]): number {
  const numerator = entries.reduce((total, entry) => total + numeratorOf(entry), 0);
  const denominator = BPS * BPS;
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(numerator) / denominator);
}

/**
 * Every entry a deal produces, one per person on it.
 *
 * Returns an empty array when the deal earns nothing — below a threshold, or at a
 * stage no rule names. That is the common case under a tiered plan and is not an
 * error.
 */
export function accrueForDeal(
  deal: DealForAccrual,
  plan: CommissionPlan,
  makeId: (dealId: string, personId: string) => string,
): AccrualEntry[] {
  const version = versionInForceAt(plan, deal.occurredAt);
  if (!version) return [];

  const rule = ruleFor(version, deal.stage, deal.valueMinor);
  if (!rule) return [];

  const total = deal.splits.reduce((sum, split) => sum + split.splitBps, 0);
  if (deal.splits.length > 0 && total !== BPS)
    throw new CommissionAccrualError(
      `splits on deal ${deal.dealId} total ${total} basis points, not ${BPS}`,
    );

  const splits = deal.splits.length > 0 ? deal.splits : [];
  return splits.map((split) => ({
    entryId: makeId(deal.dealId, split.personId),
    organizationId: deal.organizationId,
    personId: split.personId,
    dealId: deal.dealId,
    planId: plan.planId,
    planVersion: version.version,
    reason: "earned" as const,
    basisMinor: deal.valueMinor,
    rateBps: rule.rateBps,
    splitBps: split.splitBps,
    occurredAt: deal.occurredAt,
  }));
}

export interface AccrualLine {
  readonly dealId: string;
  readonly entries: readonly AccrualEntry[];
  readonly payoutMinor: number;
}

/**
 * A person's accrual, broken down by the deals that produced it.
 *
 * Ticket 05's second criterion, and the shape a dispute is answered in: the total
 * is the rounded sum of the WHOLE set, while each line shows its own contribution
 * — so the lines may not sum to the total by a single minor unit, and that is the
 * rounding rule being visible rather than a mistake. Stated here so nobody
 * "fixes" it into per-line rounding and reintroduces the drift.
 */
export function decomposeForPerson(
  entries: readonly AccrualEntry[],
  personId: string,
): { readonly lines: readonly AccrualLine[]; readonly payoutMinor: number } {
  const mine = entries.filter((entry) => entry.personId === personId);
  const byDeal = new Map<string, AccrualEntry[]>();
  for (const entry of mine) {
    const list = byDeal.get(entry.dealId) ?? [];
    list.push(entry);
    byDeal.set(entry.dealId, list);
  }

  const lines = [...byDeal.entries()]
    .map(([dealId, dealEntries]) => ({
      dealId,
      entries: dealEntries,
      payoutMinor: payoutMinor(dealEntries),
    }))
    .sort((a, b) => a.dealId.localeCompare(b.dealId));

  return { lines, payoutMinor: payoutMinor(mine) };
}
