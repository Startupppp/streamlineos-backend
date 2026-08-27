import type { StripeOutcome, StripePlatformPayment } from "./stripe-platform-events";

/**
 * What a Stripe delivery is allowed to do, given what the ledger already holds.
 *
 * Stripe states plainly that events are not ordered and that any event may be
 * delivered more than once. Both are ordinary, not exotic: a failed card attempt
 * and its successful retry share one PaymentIntent, and the two events race; a
 * refund and the payment it reverses race; the same `evt_` id arrives twice
 * because the first acknowledgement was lost.
 *
 * The rule that makes all of it safe is that the ledger only ever moves forward.
 * Deciding that here, against a snapshot, is what lets every case be stated as a
 * fixture -- the alternative is discovering the ordering rules from production
 * refunds.
 */

/**
 * Higher wins. A stored outcome is never replaced by a lower-ranked one, so the
 * row a late `payment_intent.payment_failed` finds already captured stays
 * captured, and a refund is terminal whenever it arrives.
 */
const RANK: Readonly<Record<StripeOutcome, number>> = {
  failed: 0,
  captured: 1,
  refunded: 2,
};

export interface StripeLedgerState {
  /** What `platform_payments` already holds for this intent, if anything. */
  readonly recordedOutcome: StripeOutcome | null;
  /** Minor units already recorded as refunded, so a partial is not undone. */
  readonly recordedRefundMinor: number;
  /** True when `subscription_payments` already holds a row for this intent. */
  readonly alreadyCredited: boolean;
}

export interface StripeWebhookPlan {
  /** The outcome to store: the winner of incoming versus recorded, never lower. */
  readonly outcome: StripeOutcome;
  readonly amountRefundedMinor: number;
  /** False when this delivery adds nothing the ledger does not already say. */
  readonly advancesLedger: boolean;
  readonly creditSubscription: boolean;
  readonly markPastDue: boolean;
}

export function planStripeWebhook(
  payment: StripePlatformPayment,
  state: StripeLedgerState,
): StripeWebhookPlan {
  const recordedRank = state.recordedOutcome === null ? -1 : RANK[state.recordedOutcome];
  const incomingRank = RANK[payment.outcome];

  const outcome = incomingRank > recordedRank ? payment.outcome : (state.recordedOutcome ?? payment.outcome);
  const amountRefundedMinor = Math.max(payment.amountRefundedMinor, state.recordedRefundMinor);

  const advancesLedger =
    incomingRank > recordedRank || amountRefundedMinor > state.recordedRefundMinor;

  /*
    "This event says the sale completed", not "this event is the first to say so".

    Deliberately independent of `alreadyCredited`. A delivery that dies between
    writing the subscription payment and granting the credits has to be able to
    finish on retry, and it cannot if the retry concludes there is nothing left
    to do. Once-only is the LEDGER's job -- an existence check under an advisory
    lock, and an effect key on the grant -- not this function's.

    The two conditions that are real refusals stay. Only a PaymentIntent success
    buys anything: a partially refunded charge also reports `captured`, and
    crediting from it would hand a subscription to somebody who just took money
    back. And a sale whose refund is already recorded is not resurrected by a
    success that arrives after it.
  */
  const creditSubscription =
    payment.source === "intent" &&
    payment.outcome === "captured" &&
    state.recordedOutcome !== "refunded";

  /*
    A failure only means past due while nothing has been paid.

    The common Stripe sequence is a declined attempt followed by a successful
    retry on the SAME intent, and the two events race. Marking past due on a
    failure that arrives after the money did would suspend a tenant who paid.
  */
  const markPastDue =
    payment.outcome === "failed" && state.recordedOutcome === null && !state.alreadyCredited;

  return { outcome, amountRefundedMinor, advancesLedger, creditSubscription, markPastDue };
}
