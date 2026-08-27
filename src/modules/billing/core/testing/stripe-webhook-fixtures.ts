/**
 * Stripe's documented webhook bodies, trimmed to the fields the platform reads.
 *
 * The rule for this phase is that payment providers are exercised from fixtures
 * rather than a mocked SDK: a mock only ever proves it agrees with itself, and
 * what breaks a deployment is the shape on the wire. Every value below is the
 * shape Stripe actually sends -- including the two that catch people out, a
 * refunded charge whose `status` is still `"succeeded"`, and `latest_charge`
 * arriving as an id because webhook deliveries are never expanded.
 *
 * The metadata is what `BillingService.createOrder` stamps on an intent, so
 * these bodies round-trip the terms of a real sale rather than a made-up one.
 */

const INTENT_ID = "pi_3MtwBwLkdIwHu7ix28a3tqPa";
const CHARGE_ID = "ch_3MtwBwLkdIwHu7ix2AoMlDkC";

/** A EUR annual PROFESSIONAL sale: the case Razorpay could not serve. */
const AMOUNT_MINOR = 239_900;

const SALE_METADATA = {
  orgId: "org-berlin",
  plan: "PROFESSIONAL",
  userId: "user-1",
  billingCycle: "annual",
  netMinor: "201_596",
  taxMinor: "38_304",
  taxTreatment: "standard",
  ratesVersion: "2026.1",
  receipt: "sub_rg-berlin_20260827",
};

function envelope(type: string, eventId: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2024-06-20",
    created: 1_772_150_400,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: "req_qhIhJTjJPQCatf", idempotency_key: SALE_METADATA.receipt },
    type,
  });
}

export function paymentIntentSucceededEvent(
  overrides: Record<string, unknown> = {},
  eventId = "evt_3MtwBwLkdIwHu7ix0lSgLRRb",
): string {
  return envelope("payment_intent.succeeded", eventId, {
    id: INTENT_ID,
    object: "payment_intent",
    amount: AMOUNT_MINOR,
    amount_capturable: 0,
    amount_received: AMOUNT_MINOR,
    currency: "eur",
    // An id, not an object: Stripe never expands a webhook delivery.
    latest_charge: CHARGE_ID,
    receipt_email: "ops@berlin.example",
    metadata: SALE_METADATA,
    status: "succeeded",
    ...overrides,
  });
}

export function paymentIntentFailedEvent(
  overrides: Record<string, unknown> = {},
  eventId = "evt_3MtwBwLkdIwHu7ix0FailEd1",
): string {
  return envelope("payment_intent.payment_failed", eventId, {
    id: INTENT_ID,
    object: "payment_intent",
    amount: AMOUNT_MINOR,
    amount_received: 0,
    currency: "eur",
    latest_charge: null,
    metadata: SALE_METADATA,
    last_payment_error: {
      code: "card_declined",
      decline_code: "generic_decline",
      message: "Your card was declined.",
      type: "card_error",
    },
    // Not "failed": a failed intent goes back to requiring a payment method,
    // which is why the event type decides the outcome and the status does not.
    status: "requires_payment_method",
    ...overrides,
  });
}

export function chargeRefundedEvent(
  overrides: Record<string, unknown> = {},
  eventId = "evt_3MtwBwLkdIwHu7ixRefund1",
): string {
  return envelope("charge.refunded", eventId, {
    id: CHARGE_ID,
    object: "charge",
    amount: AMOUNT_MINOR,
    amount_captured: AMOUNT_MINOR,
    amount_refunded: AMOUNT_MINOR,
    billing_details: { email: "ops@berlin.example", name: null },
    currency: "eur",
    payment_intent: INTENT_ID,
    receipt_email: null,
    refunded: true,
    metadata: SALE_METADATA,
    // The trap: a refunded charge is still a succeeded charge to Stripe.
    status: "succeeded",
    ...overrides,
  });
}

export const STRIPE_FIXTURE = {
  intentId: INTENT_ID,
  chargeId: CHARGE_ID,
  amountMinor: AMOUNT_MINOR,
  orgId: SALE_METADATA.orgId,
  plan: SALE_METADATA.plan,
  billingCycle: SALE_METADATA.billingCycle,
} as const;
