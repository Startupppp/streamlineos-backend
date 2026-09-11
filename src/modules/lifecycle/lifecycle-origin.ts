import {
  DEFAULT_TERM_MONTHS,
  calendarDateOf,
  formatIsoDate,
  parseIsoDate,
  renewalDate,
  termMonthsFrom,
} from "./lifecycle-terms";

/**
 * The rule that turns a won deal into a term.
 *
 * Pure and separate from the service, because this is where the feature can
 * silently do the wrong thing: writing a lifecycle for a deal that names no
 * customer, or refusing to write one for a deal that does. Both failures are
 * invisible at runtime — the first puts untraceable money in the renewal
 * forecast, the second loses real money out of it — and neither shows up in a
 * test that mocks the database and asserts an insert happened.
 *
 * A refusal is a value here, never a throw. This runs inside the transaction
 * that moves the deal, so an exception would roll back the stage change itself:
 * a rep would click "Closed Won", get an error, and the deal would still be in
 * negotiation. Failing to open a renewal record must never be able to fail to
 * close a sale.
 */

export interface ClosedWonDeal {
  readonly organizationId: string;
  readonly dealId: number;
  /** The customer, already resolved to a Party by the caller. Null when none resolves. */
  readonly partyId: string | null;
  readonly valueMinor: number;
  /** `deals.actual_close_date`, which the won transition sets. */
  readonly actualCloseDate: string | null;
  readonly customData: unknown;
  readonly now: Date;
}

export interface LifecycleOriginValues {
  readonly organizationId: string;
  readonly partyId: string;
  readonly sourceDealId: number;
  readonly startedOn: string;
  readonly termMonths: number;
  readonly renewalOn: string;
  readonly contractValueMinor: number;
}

export type LifecycleOrigin =
  | { readonly ok: true; readonly values: LifecycleOriginValues }
  /**
   * `no-party` is the only refusal, and it is not an error condition. Deals are
   * routinely won against a lead that was never converted; there is no customer
   * to hold a recurring relationship with, so there is no lifecycle.
   */
  | { readonly ok: false; readonly reason: "no-party" | "unusable-term" };

/**
 * A won deal's value can be zero — a pilot, a goodwill renewal, a correction
 * pending — and that is still a relationship worth tracking to its renewal.
 * Negative is not: it is a data error, and it is floored rather than refused so
 * the customer stays in the book with a value somebody can see is wrong.
 */
function contractValue(valueMinor: number): number {
  if (!Number.isFinite(valueMinor)) return 0;
  return Math.max(0, Math.trunc(valueMinor));
}

export function lifecycleFromClosedWon(deal: ClosedWonDeal): LifecycleOrigin {
  if (!deal.partyId) return { ok: false, reason: "no-party" };

  /**
   * The stated close date, or today. `actual_close_date` is set by the same
   * update that triggers this, so it is normally present — but a deal imported
   * straight into a won stage has never had one written, and dating its term
   * from nothing would produce a renewal date of `null` on a NOT NULL column.
   */
  const startedOn = parseIsoDate(deal.actualCloseDate)
    ? deal.actualCloseDate!.trim()
    : formatIsoDate(calendarDateOf(deal.now));

  const termMonths = termMonthsFrom(deal.customData);

  /**
   * `termMonthsFrom` bounds its answer and `startedOn` is parseable by
   * construction, so the first call answers in every reachable case. The
   * fallback and the refusal below exist so that a future change to either
   * function degrades into a correct annual term, and then into a stated
   * refusal — never into a `null` on a NOT NULL column, which is the one
   * outcome that would abort the transaction closing the sale.
   */
  const renewalOn =
    renewalDate(startedOn, termMonths) ?? renewalDate(startedOn, DEFAULT_TERM_MONTHS);
  if (!renewalOn) return { ok: false, reason: "unusable-term" };

  return {
    ok: true,
    values: {
      organizationId: deal.organizationId,
      partyId: deal.partyId,
      sourceDealId: deal.dealId,
      startedOn,
      termMonths,
      renewalOn,
      contractValueMinor: contractValue(deal.valueMinor),
    },
  };
}
