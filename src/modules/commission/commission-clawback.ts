import {
  payoutMinor,
  type AccrualEntry,
} from "./commission-accrual";

/**
 * A reversed deal clawed back through the ledger that paid it.
 *
 * Phase 5, ticket 06. The rule is that a clawback is an ENTRY, never a
 * recalculation: the original stays exactly as it was, and a second entry of the
 * opposite sign is written beside it carrying what it reverses and why. A system
 * that instead deletes or edits the original leaves the person's total changing
 * with no record of what changed it, which is the thing a dispute cannot survive.
 */
export type NegativePolicy = "carry-forward" | "floor-at-zero";

export interface ClawbackInput {
  readonly original: AccrualEntry;
  readonly reason: string;
  readonly occurredAt: Date;
  readonly entryId: string;
}

export class CommissionClawbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionClawbackError";
  }
}

/**
 * The mirror of an entry.
 *
 * It copies the original's basis, rate and split rather than recomputing them —
 * the plan may have changed since, and a clawback that used today's rate would
 * take back a different amount from the one that was paid.
 */
export function clawbackFor(input: ClawbackInput): AccrualEntry {
  const { original } = input;
  if (original.reason === "clawback")
    throw new CommissionClawbackError(
      `entry ${original.entryId} is itself a clawback and cannot be reversed again`,
    );
  if (!input.reason.trim())
    throw new CommissionClawbackError("a clawback must carry a reason");

  return {
    ...original,
    entryId: input.entryId,
    reason: "clawback",
    occurredAt: input.occurredAt,
    reversesEntryId: original.entryId,
    note: input.reason,
  };
}

export interface ClawbackNotice {
  readonly personId: string;
  readonly dealId: string;
  /** Positive: what is being taken back. */
  readonly amountMinor: number;
  readonly reason: string;
  readonly balanceAfterMinor: number;
  readonly carriedForwardMinor: number;
}

/**
 * Applying a clawback, under a stated policy for going negative.
 *
 * Ticket 06's last criterion asks that a clawback taking an accrual negative be
 * "handled by stated policy rather than by arithmetic accident". Both policies
 * are honest; they differ in who carries the risk:
 *
 * - `carry-forward` leaves the balance negative, so the next month's earnings pay
 *   it off. The company is made whole and the rep owes the difference.
 * - `floor-at-zero` stops at nought and records what was NOT recovered, so a rep
 *   is never shown a negative balance and the shortfall is visible to whoever
 *   decides whether to pursue it.
 *
 * Neither is chosen here. The caller passes one, because it is a commercial
 * decision and a default would make it silently.
 */
export function applyClawback(
  ledger: readonly AccrualEntry[],
  clawback: AccrualEntry,
  policy: NegativePolicy,
): { readonly entries: readonly AccrualEntry[]; readonly notice: ClawbackNotice } {
  const before = payoutMinor(ledger.filter((e) => e.personId === clawback.personId));
  const withClawback = [...ledger, clawback];
  const after = payoutMinor(withClawback.filter((e) => e.personId === clawback.personId));

  const amount = before - after;

  if (policy === "carry-forward" || after >= 0) {
    return {
      entries: withClawback,
      notice: {
        personId: clawback.personId,
        dealId: clawback.dealId,
        amountMinor: amount,
        reason: clawback.note ?? "",
        balanceAfterMinor: after,
        carriedForwardMinor: after < 0 ? -after : 0,
      },
    };
  }

  // floor-at-zero, and the balance would go under. The clawback is still
  // RECORDED -- the criterion is that it is never a silent recalculation -- and
  // what could not be recovered is reported rather than absorbed.
  return {
    entries: withClawback,
    notice: {
      personId: clawback.personId,
      dealId: clawback.dealId,
      amountMinor: amount,
      reason: clawback.note ?? "",
      balanceAfterMinor: 0,
      carriedForwardMinor: -after,
    },
  };
}
