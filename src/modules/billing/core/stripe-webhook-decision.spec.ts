import { translateStripeEvent, type StripePlatformPayment } from "./stripe-platform-events";
import { planStripeWebhook, type StripeLedgerState } from "./stripe-webhook-decision";
import {
  chargeRefundedEvent,
  paymentIntentFailedEvent,
  paymentIntentSucceededEvent,
} from "./testing/stripe-webhook-fixtures";

/**
 * The ordering rules, argued with as fixtures rather than as production refunds.
 *
 * Stripe states plainly that events are not ordered and that any event may be
 * delivered more than once. Both are ordinary here: a declined card attempt and
 * its successful retry share one PaymentIntent and race; a refund races the
 * payment it reverses. The invariant that makes all of it safe is that the
 * ledger only moves forward.
 */

function paymentFrom(body: string): StripePlatformPayment {
  const result = translateStripeEvent(body);
  if (!result.ok || result.kind !== "payment") throw new Error("fixture is not a payment event");
  return result.payment;
}

const NOTHING_RECORDED: StripeLedgerState = {
  recordedOutcome: null,
  recordedRefundMinor: 0,
  alreadyCredited: false,
};

describe("planStripeWebhook — first delivery of each event", () => {
  it("credits the subscription on a captured intent nothing has seen before", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentSucceededEvent()), NOTHING_RECORDED);

    expect(plan).toMatchObject({
      outcome: "captured",
      advancesLedger: true,
      creditSubscription: true,
      markPastDue: false,
    });
  });

  it("marks past due on a failure while nothing has been paid", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentFailedEvent()), NOTHING_RECORDED);

    expect(plan).toMatchObject({
      outcome: "failed",
      advancesLedger: true,
      creditSubscription: false,
      markPastDue: true,
    });
  });

  it("records a refund without crediting anything", () => {
    const plan = planStripeWebhook(paymentFrom(chargeRefundedEvent()), {
      recordedOutcome: "captured",
      recordedRefundMinor: 0,
      alreadyCredited: true,
    });

    expect(plan).toMatchObject({
      outcome: "refunded",
      amountRefundedMinor: 239_900,
      advancesLedger: true,
      creditSubscription: false,
    });
  });
});

describe("planStripeWebhook — the same event delivered twice", () => {
  /**
   * A redelivered success still says "credit it", deliberately.
   *
   * Refusing here would be the tempting shape and it loses money: a delivery
   * that died after the subscription payment was written but before the credits
   * were granted has to be able to finish on retry. Once-only belongs to the
   * ledger -- an existence check under an advisory lock, and an effect key on
   * the grant -- and is asserted there, on row counts, in
   * `stripe-webhook.service.spec.ts`.
   */
  it("still asks to credit when the intent is already on the ledger, so a half-finished delivery can resume", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentSucceededEvent()), {
      recordedOutcome: "captured",
      recordedRefundMinor: 0,
      alreadyCredited: true,
    });

    expect(plan.creditSubscription).toBe(true);
  });

  it("reports a redelivered success as adding nothing, so the row is not rewritten", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentSucceededEvent()), {
      recordedOutcome: "captured",
      recordedRefundMinor: 0,
      alreadyCredited: true,
    });

    expect(plan.advancesLedger).toBe(false);
  });

  it("a redelivered refund neither advances the ledger nor increases the refunded amount", () => {
    const plan = planStripeWebhook(paymentFrom(chargeRefundedEvent()), {
      recordedOutcome: "refunded",
      recordedRefundMinor: 239_900,
      alreadyCredited: true,
    });

    expect(plan).toMatchObject({ advancesLedger: false, amountRefundedMinor: 239_900 });
  });
});

describe("planStripeWebhook — deliveries that arrive out of order", () => {
  /**
   * The sequence Stripe produces constantly and nobody tests.
   *
   * A declined attempt and its successful retry are two events on ONE intent.
   * If the failure lands after the success, suspending the tenant is suspending
   * somebody who paid.
   */
  it("does not suspend a tenant when a stale failure lands after the money did", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentFailedEvent()), {
      recordedOutcome: "captured",
      recordedRefundMinor: 0,
      alreadyCredited: true,
    });

    expect(plan.markPastDue).toBe(false);
  });

  it("keeps the payment captured when a stale failure lands after it", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentFailedEvent()), {
      recordedOutcome: "captured",
      recordedRefundMinor: 0,
      alreadyCredited: true,
    });

    expect(plan).toMatchObject({ outcome: "captured", advancesLedger: false });
  });

  /**
   * Refund first, payment second.
   *
   * Impossible in reality and entirely possible in delivery order. The sale must
   * not be credited by an event that a later-ranked one has already reversed,
   * and the row must stay refunded.
   */
  it("refuses to credit a sale whose refund has already been recorded", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentSucceededEvent()), {
      recordedOutcome: "refunded",
      recordedRefundMinor: 239_900,
      alreadyCredited: false,
    });

    expect(plan).toMatchObject({ creditSubscription: false, outcome: "refunded" });
  });

  it("does not walk a refunded payment back to captured", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentSucceededEvent()), {
      recordedOutcome: "refunded",
      recordedRefundMinor: 239_900,
      alreadyCredited: true,
    });

    expect(plan.outcome).toBe("refunded");
  });

  it("still suspends when a failure arrives before anything else", () => {
    const plan = planStripeWebhook(paymentFrom(paymentIntentFailedEvent()), NOTHING_RECORDED);

    expect(plan.markPastDue).toBe(true);
  });
});

describe("planStripeWebhook — partial refunds", () => {
  /**
   * A partial refund reports `captured`, correctly: most of the sale stands.
   * Crediting from it would hand a subscription to somebody who just took money
   * back, so the SOURCE is checked as well as the outcome.
   */
  it("never credits a subscription from a charge event, however it is ranked", () => {
    const plan = planStripeWebhook(
      paymentFrom(chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 })),
      NOTHING_RECORDED,
    );

    expect(plan).toMatchObject({ outcome: "captured", creditSubscription: false });
  });

  it("advances the ledger for a partial refund even though the outcome is unchanged", () => {
    const plan = planStripeWebhook(
      paymentFrom(chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 })),
      { recordedOutcome: "captured", recordedRefundMinor: 0, alreadyCredited: true },
    );

    expect(plan).toMatchObject({ advancesLedger: true, amountRefundedMinor: 50_000 });
  });

  it("never reduces an already recorded refund", () => {
    const plan = planStripeWebhook(
      paymentFrom(chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 })),
      { recordedOutcome: "refunded", recordedRefundMinor: 239_900, alreadyCredited: true },
    );

    expect(plan).toMatchObject({ amountRefundedMinor: 239_900, advancesLedger: false });
  });
});
