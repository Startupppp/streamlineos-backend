import { translateStripeEvent } from "./stripe-platform-events";
import {
  chargeRefundedEvent,
  paymentIntentFailedEvent,
  paymentIntentSucceededEvent,
} from "./testing/stripe-webhook-fixtures";

/**
 * Driven from Stripe's own documented bodies, never a mocked SDK.
 *
 * A mocked SDK tests that the mock agrees with itself. What actually breaks a
 * deployment is the shape on the wire -- `charge.refunded` carrying
 * `status: "succeeded"`, a partial refund arriving on the same event type as a
 * full one, `latest_charge` being an id rather than an object.
 */
describe("translateStripeEvent", () => {
  it("reads a successful payment off the PaymentIntent, not off a charge", () => {
    const result = translateStripeEvent(paymentIntentSucceededEvent());

    expect(result).toMatchObject({
      ok: true,
      kind: "payment",
      payment: {
        eventId: "evt_3MtwBwLkdIwHu7ix0lSgLRRb",
        intentId: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
        chargeId: "ch_3MtwBwLkdIwHu7ix2AoMlDkC",
        source: "intent",
        outcome: "captured",
        currency: "EUR",
      },
    });
  });

  it("carries the plan and cycle createOrder stamped on the intent", () => {
    const result = translateStripeEvent(paymentIntentSucceededEvent());

    expect(result).toMatchObject({
      ok: true,
      payment: { notes: { orgId: "org-berlin", plan: "PROFESSIONAL", billingCycle: "annual" } },
    });
  });

  /**
   * `amount_received`, not `amount`.
   *
   * They differ whenever an intent is captured for less than it authorised, and
   * the ledger has to hold what was taken. Reading `amount` records a number the
   * customer was never charged.
   */
  it("records what was received when it differs from what was authorised", () => {
    const body = paymentIntentSucceededEvent({ amount: 239_900, amount_received: 200_000 });

    const result = translateStripeEvent(body);

    expect(result).toMatchObject({ ok: true, payment: { amountMinor: 200_000 } });
  });

  it("reads a failure and the reason Stripe gave for it", () => {
    const result = translateStripeEvent(paymentIntentFailedEvent());

    expect(result).toMatchObject({
      ok: true,
      payment: {
        intentId: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
        outcome: "failed",
        failureMessage: "Your card was declined.",
      },
    });
  });

  /**
   * The trap this whole translation exists for.
   *
   * A refunded charge still reports `status: "succeeded"` -- the refund lives in
   * `refunded` and `amount_refunded`. The Razorpay path reads a lifecycle string
   * to decide what happened, and doing that here records every refund as a
   * successful payment.
   */
  it("treats a fully refunded charge as a refund even though its status says succeeded", () => {
    const result = translateStripeEvent(chargeRefundedEvent());

    expect(result).toMatchObject({
      ok: true,
      payment: {
        intentId: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
        chargeId: "ch_3MtwBwLkdIwHu7ix2AoMlDkC",
        source: "charge",
        outcome: "refunded",
        amountRefundedMinor: 239_900,
      },
    });
  });

  /**
   * A partial refund is not a refund of the sale.
   *
   * Stripe fires the same event type for both. Treating a partial as terminal
   * closes a subscription the customer still holds most of.
   */
  it("keeps a partially refunded charge captured, and records how much came back", () => {
    const body = chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 });

    const result = translateStripeEvent(body);

    expect(result).toMatchObject({
      ok: true,
      payment: { outcome: "captured", amountRefundedMinor: 50_000 },
    });
  });

  it("normalises the currency up, so a Stripe row and a Razorpay row agree", () => {
    const result = translateStripeEvent(paymentIntentSucceededEvent());

    expect(result).toMatchObject({ ok: true, payment: { currency: "EUR" } });
  });

  /**
   * Explicitly listed types only.
   *
   * An endpoint subscribed to everything sees hundreds. Acting on an unknown one
   * is how `charge.succeeded` and `payment_intent.succeeded` for a single sale
   * become two credits.
   */
  it.each([
    "charge.succeeded",
    "payment_intent.created",
    "customer.subscription.updated",
    "invoice.paid",
  ])("acknowledges %s without acting on it", (type) => {
    const body = JSON.stringify({
      id: "evt_ignored_1",
      object: "event",
      type,
      data: { object: { id: "obj_1", object: "charge" } },
    });

    expect(translateStripeEvent(body)).toEqual({
      ok: true,
      kind: "ignored",
      eventId: "evt_ignored_1",
      eventType: type,
    });
  });

  describe("refuses what it cannot read, rather than guessing", () => {
    it("rejects a body that is not JSON", () => {
      expect(translateStripeEvent("not json at all")).toEqual({
        ok: false,
        reason: "invalid_json",
      });
    });

    it("rejects an event with no type or no data object", () => {
      expect(translateStripeEvent(JSON.stringify({ id: "evt_1" }))).toEqual({
        ok: false,
        reason: "invalid_envelope",
      });
    });

    it("rejects a payment_intent event whose object is not a payment intent", () => {
      const body = JSON.stringify({
        id: "evt_1",
        object: "event",
        type: "payment_intent.succeeded",
        data: { object: { id: "ch_1", object: "charge" } },
      });

      expect(translateStripeEvent(body)).toEqual({ ok: false, reason: "invalid_object" });
    });

    /**
     * A charge with no intent is a legacy direct charge. The platform only ever
     * creates intents, so one arriving here is not a sale of ours -- and there
     * is nothing it could be attributed to.
     */
    it("rejects a refunded charge that names no payment intent", () => {
      const body = chargeRefundedEvent({ payment_intent: null });

      expect(translateStripeEvent(body)).toEqual({ ok: false, reason: "invalid_object" });
    });
  });
});
