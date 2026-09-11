import {
  stripeEventEnvelopeSchema,
  stripeWebhookChargeSchema,
  stripeWebhookIntentSchema,
} from "./dto/billing.schemas";

/**
 * Stripe's webhook events, turned into the one shape billing acts on.
 *
 * Pure, and separate from the service, because every interesting property of
 * this translation is a property of the payload -- a refunded charge whose
 * `status` still reads `succeeded`, a partial refund that is not a refund of the
 * whole sale, an event type nobody has taught us about yet. Those are argued
 * with in a test against Stripe's own documented bodies rather than in
 * production against a mocked SDK, which is this phase's rule for providers.
 */

/**
 * What actually happened to the money.
 *
 * Ordered, and the order is load-bearing: deliveries arrive out of order, so a
 * stored outcome is only ever advanced, never walked backwards. See
 * `stripe-webhook-decision.ts`.
 */
export type StripeOutcome = "failed" | "captured" | "refunded";

/** Which Stripe resource carried the news, which decides what it may authorise. */
export type StripeEventSource = "intent" | "charge";

export interface StripePlatformPayment {
  /** Stripe's `evt_...`, stable across every retry of the same delivery. */
  readonly eventId: string;
  readonly eventType: string;
  /**
   * The PaymentIntent, which is the identity of the sale.
   *
   * Charges hang off an intent and a retried card attempt makes a new one, so
   * the intent is the only id that means "this purchase" across every event.
   */
  readonly intentId: string;
  readonly chargeId: string | null;
  readonly source: StripeEventSource;
  readonly outcome: StripeOutcome;
  /** Minor units, matching what was charged. */
  readonly amountMinor: number;
  readonly amountRefundedMinor: number;
  /** ISO 4217 upper, so a Stripe row and a Razorpay row hold the same string. */
  readonly currency: string;
  readonly email: string | null;
  /** Stripe's `metadata`, which is what `createOrder` attached as `notes`. */
  readonly notes: Record<string, string>;
  readonly failureMessage: string | null;
}

export type StripeEventTranslation =
  | { readonly ok: true; readonly kind: "payment"; readonly payment: StripePlatformPayment }
  | { readonly ok: true; readonly kind: "ignored"; readonly eventId: string; readonly eventType: string }
  | { readonly ok: false; readonly reason: "invalid_json" | "invalid_envelope" | "invalid_object" };

/**
 * The three events that move money, and nothing else.
 *
 * Stripe sends upwards of two hundred event types to an endpoint subscribed to
 * everything. Acting on an unknown one is how a `charge.succeeded` and a
 * `payment_intent.succeeded` for the same sale become two credits, so the list
 * is explicit and short and anything outside it is acknowledged and dropped.
 */
const HANDLED = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
]);

export function translateStripeEvent(rawBody: string): StripeEventTranslation {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const envelope = stripeEventEnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) return { ok: false, reason: "invalid_envelope" };

  const { id: eventId, type: eventType, data } = envelope.data;
  if (!HANDLED.has(eventType)) return { ok: true, kind: "ignored", eventId, eventType };

  if (eventType === "charge.refunded") {
    const charge = stripeWebhookChargeSchema.safeParse(data.object);
    if (!charge.success) return { ok: false, reason: "invalid_object" };
    const entity = charge.data;

    /*
      A charge with no intent is a legacy direct charge. The platform only ever
      creates intents, so one arriving here is not a sale of ours and there is
      nothing it could be attributed to -- refusing beats inventing an id.
    */
    if (!entity.payment_intent) return { ok: false, reason: "invalid_object" };

    /*
      A partial refund is not a refund of the sale.

      Stripe fires `charge.refunded` for both, distinguished by `refunded` and
      by `amount_refunded` against `amount`. Treating a partial as terminal
      would close a subscription somebody still holds most of.
    */
    const fullyRefunded = entity.refunded || entity.amount_refunded >= entity.amount;

    return {
      ok: true,
      kind: "payment",
      payment: {
        eventId,
        eventType,
        intentId: entity.payment_intent,
        chargeId: entity.id,
        source: "charge",
        outcome: fullyRefunded ? "refunded" : "captured",
        amountMinor: entity.amount,
        amountRefundedMinor: entity.amount_refunded,
        currency: entity.currency.toUpperCase(),
        email: entity.receipt_email ?? entity.billing_details?.email ?? null,
        notes: entity.metadata,
        failureMessage: null,
      },
    };
  }

  const intent = stripeWebhookIntentSchema.safeParse(data.object);
  if (!intent.success) return { ok: false, reason: "invalid_object" };
  const entity = intent.data;

  const succeeded = eventType === "payment_intent.succeeded";

  /*
    `amount_received` rather than `amount` on a success.

    They differ whenever the intent was captured for less than it authorised,
    and the ledger has to record what was taken, not what was asked for.
  */
  const amountMinor = succeeded ? (entity.amount_received ?? entity.amount) : entity.amount;

  return {
    ok: true,
    kind: "payment",
    payment: {
      eventId,
      eventType,
      intentId: entity.id,
      chargeId: entity.latest_charge ?? null,
      source: "intent",
      outcome: succeeded ? "captured" : "failed",
      amountMinor,
      amountRefundedMinor: 0,
      currency: entity.currency.toUpperCase(),
      email: entity.receipt_email ?? null,
      notes: entity.metadata,
      failureMessage: succeeded ? null : (entity.last_payment_error?.message ?? null),
    },
  };
}
