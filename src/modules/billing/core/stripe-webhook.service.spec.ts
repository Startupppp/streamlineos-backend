import { createHmac } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { AppConfig } from "../../../config/env.validation";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { RazorpayService } from "./razorpay.service";
import { StripeService } from "./stripe.service";
import { StripePlatformWebhookService } from "./stripe-webhook.service";
import { REPLAY_TOLERANCE_SECONDS } from "./stripe-signature";
import {
  StripeWebhookLedger,
  type StripeCreditInput,
  type StripeCreditResult,
  type StripeEventRecord,
  type StripeEventRecording,
  type StripePaymentRow,
  type StripeWebhookLedgerPort,
} from "./stripe-webhook-ledger";
import type { StripeLedgerState } from "./stripe-webhook-decision";
import {
  STRIPE_FIXTURE,
  chargeRefundedEvent,
  paymentIntentFailedEvent,
  paymentIntentSucceededEvent,
} from "./testing/stripe-webhook-fixtures";

const WEBHOOK_SECRET = "whsec_test_secret";

/**
 * A Stripe-only deployment: no Razorpay credentials at all.
 *
 * The configuration ticket 02 exists for, and the one every earlier gate got
 * wrong -- so the whole suite runs on it rather than on a deployment where
 * Razorpay would have covered for a mistake.
 */
const STRIPE_ONLY = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PUBLISHABLE_KEY: "pk_test_x",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as AppConfig;

/**
 * Signs the way Stripe signs, so the real verifier is exercised.
 *
 * Stubbing `verifyWebhookSignature` would mean the suite never touches the code
 * that decides whether a delivery is genuine -- which is the code an attacker
 * is aiming at.
 */
function sign(rawBody: string, secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${at}.${rawBody}`).digest("hex");
  return `t=${at},v1=${signature}`;
}

interface StoredPayment {
  intentId: string;
  chargeId: string | null;
  status: string;
  amountMinor: number;
  amountRefundedMinor: number;
  currency: string;
  refundedAt: Date | null;
}

interface StoredSubscriptionPayment {
  intentId: string;
  amount: string;
  currency: string;
}

/**
 * The ledger, in memory, with the same two uniqueness rules Postgres enforces.
 *
 * This is what makes "a duplicate delivery credits once" an assertion about
 * rows. A jest double would let the handler insert twice and still pass, which
 * is precisely the bug being guarded against.
 */
class InMemoryLedger implements StripeWebhookLedgerPort {
  readonly events = new Map<string, { eventType: string; processedAt: Date | null }>();
  readonly payments = new Map<string, StoredPayment>();
  readonly subscriptionPayments: StoredSubscriptionPayment[] = [];
  subscription: { plan: string; status: string; periodEnd: Date } | null = null;

  async recordEvent(_orgId: string, event: StripeEventRecord): Promise<StripeEventRecording> {
    // The unique index on (provider, provider_event_id) -- and the distinction
    // between a redelivery of finished work and a retry of unfinished work.
    const existing = this.events.get(event.eventId);
    if (existing) return existing.processedAt ? "duplicate" : "resume";
    this.events.set(event.eventId, { eventType: event.eventType, processedAt: null });
    return "first";
  }

  async readState(_orgId: string, intentId: string): Promise<StripeLedgerState> {
    const payment = this.payments.get(intentId);
    const recorded = payment?.status;
    return {
      recordedOutcome:
        recorded === "captured" || recorded === "failed" || recorded === "refunded"
          ? recorded
          : null,
      recordedRefundMinor: payment?.amountRefundedMinor ?? 0,
      alreadyCredited: this.subscriptionPayments.some((row) => row.intentId === intentId),
    };
  }

  async persistPayment(_orgId: string, row: StripePaymentRow): Promise<void> {
    // The unique index on (provider, provider_payment_ref): one row per intent.
    this.payments.set(row.intentId, {
      intentId: row.intentId,
      chargeId: row.chargeId,
      status: row.outcome,
      amountMinor: row.amountMinor,
      amountRefundedMinor: row.amountRefundedMinor,
      currency: row.currency,
      refundedAt: row.outcome === "refunded" ? new Date() : null,
    });
  }

  async creditSubscription(_orgId: string, input: StripeCreditInput): Promise<StripeCreditResult> {
    if (this.subscriptionPayments.some((row) => row.intentId === input.intentId))
      return { credited: false };

    const periodEnd = new Date(input.at);
    periodEnd.setMonth(periodEnd.getMonth() + (input.billingCycle === "annual" ? 12 : 1));

    this.subscriptionPayments.push({
      intentId: input.intentId,
      amount: (input.amountMinor / 100).toFixed(2),
      currency: input.currency,
    });
    this.subscription = { plan: input.plan, status: "ACTIVE", periodEnd };
    return { credited: true, subscriptionId: 1, periodEnd };
  }

  async markPastDue(): Promise<void> {
    if (this.subscription?.status === "ACTIVE") this.subscription.status = "PAST_DUE";
  }

  async markEventProcessed(_orgId: string, eventId: string, at: Date): Promise<void> {
    const event = this.events.get(eventId);
    if (event) event.processedAt = at;
  }

  /** captured minus refunded, in minor units. The number that has to balance. */
  netCollectedMinor(): number {
    let total = 0;
    for (const payment of this.payments.values()) {
      if (payment.status === "failed") continue;
      total += payment.amountMinor - payment.amountRefundedMinor;
    }
    return total;
  }
}

function makeEffects() {
  const succeeded = new Set<string>();
  return {
    execute: jest.fn(
      async (effect: { effectKey: string }, send: () => Promise<void>): Promise<string> => {
        if (succeeded.has(effect.effectKey)) return "ALREADY_SUCCEEDED";
        await send();
        succeeded.add(effect.effectKey);
        return "EXECUTED";
      },
    ),
  };
}

interface Harness {
  service: StripePlatformWebhookService;
  ledger: InMemoryLedger;
  grantPlanCredits: jest.Mock;
  bust: jest.Mock;
}

async function buildHarness(config: AppConfig = STRIPE_ONLY): Promise<Harness> {
  const ledger = new InMemoryLedger();
  const grantPlanCredits = jest.fn().mockResolvedValue(undefined);
  const bust = jest.fn().mockResolvedValue(undefined);

  // A real registry over a real StripeService, so selection and verification are
  // the shipped code rather than a double agreeing with the test.
  const registry = new PlatformPaymentRegistry(
    new RazorpayService({} as AppConfig),
    new StripeService(config),
  );

  const module = await Test.createTestingModule({
    providers: [
      StripePlatformWebhookService,
      { provide: PlatformPaymentRegistry, useValue: registry },
      { provide: StripeWebhookLedger, useValue: ledger },
      { provide: AiCreditsService, useValue: { grantPlanCredits } },
      { provide: PlanLimitsService, useValue: { bust } },
      { provide: ExternalEffectLedger, useValue: makeEffects() },
    ],
  }).compile();

  return { service: module.get(StripePlatformWebhookService), ledger, grantPlanCredits, bust };
}

const ORG = STRIPE_FIXTURE.orgId;

describe("Stripe platform webhook — a euro customer pays", () => {
  it("activates the subscription the intent's metadata was sold for", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    const result = await service.handle(ORG, body, sign(body));

    expect(result.status).toBe(200);
    expect(ledger.subscription).toMatchObject({ plan: "PROFESSIONAL", status: "ACTIVE" });
  });

  it("writes exactly one subscription payment, for what was actually received", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));

    expect(ledger.subscriptionPayments).toEqual([
      { intentId: STRIPE_FIXTURE.intentId, amount: "2399.00", currency: "EUR" },
    ]);
  });

  it("gives an annual buyer twelve months, not one", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));

    const end = ledger.subscription?.periodEnd;
    const monthsBought = end === undefined ? 0 : monthsFromNow(end);
    expect(monthsBought).toBe(12);
  });

  it("grants the plan's AI credits once, and busts the plan-limit cache", async () => {
    const { service, grantPlanCredits, bust } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));

    expect(grantPlanCredits).toHaveBeenCalledTimes(1);
    expect(bust).toHaveBeenCalledWith(ORG);
  });

  /**
   * A Stripe-only deployment is the whole point.
   *
   * `RazorpayService` above is constructed with no credentials, so nothing in
   * this suite would pass if the path still depended on Razorpay being present.
   */
  it("works with no Razorpay credentials configured at all", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));

    expect(ledger.subscription?.status).toBe("ACTIVE");
  });
});

describe("Stripe platform webhook — duplicate delivery", () => {
  /**
   * Stripe retries a delivery with the same `evt_` id for up to three days. The
   * question is never whether it happens, only what it costs.
   */
  it("credits once when the identical event is delivered twice", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    const first = await service.handle(ORG, body, sign(body));
    const second = await service.handle(ORG, body, sign(body));

    expect(first.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true });
    expect(ledger.subscriptionPayments).toHaveLength(1);
    expect(grantPlanCredits).toHaveBeenCalledTimes(1);
  });

  it("does not extend the period a second time on a redelivery", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));
    const afterFirst = ledger.subscription?.periodEnd;
    await service.handle(ORG, body, sign(body));

    expect(ledger.subscription?.periodEnd).toEqual(afterFirst);
  });

  /**
   * The harder duplicate: two DIFFERENT events describing one sale.
   *
   * The `evt_` dedupe cannot see this one -- a resend from the dashboard, or a
   * second subscribed type covering the same intent -- so the defence has to be
   * that the intent is already on the subscription ledger.
   */
  it("credits once when a second, differently-identified event carries the same intent", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const first = paymentIntentSucceededEvent();
    const resent = paymentIntentSucceededEvent({}, "evt_resent_by_hand_001");

    await service.handle(ORG, first, sign(first));
    const second = await service.handle(ORG, resent, sign(resent));

    expect(second.status).toBe(200);
    expect(ledger.subscriptionPayments).toHaveLength(1);
    expect(grantPlanCredits).toHaveBeenCalledTimes(1);
  });

  it("keeps one payment row per intent however many events describe it", async () => {
    const { service, ledger } = await buildHarness();
    const first = paymentIntentSucceededEvent();
    const resent = paymentIntentSucceededEvent({}, "evt_resent_by_hand_001");

    await service.handle(ORG, first, sign(first));
    await service.handle(ORG, resent, sign(resent));

    expect(ledger.payments.size).toBe(1);
  });
});

describe("Stripe platform webhook — a delivery that dies partway", () => {
  /**
   * The failure mode a naive dedupe creates.
   *
   * If the credit grant fails after the subscription payment is written, the
   * handler returns 500 and Stripe retries -- and a dedupe that stops at "I
   * have seen this event id" answers 200 to that retry and the tenant never
   * receives the credits they paid for. The event row is only marked processed
   * once the whole thing succeeded, so an unprocessed row means resume.
   */
  it("resumes and grants the credits when the first attempt failed after crediting", async () => {
    const { service, grantPlanCredits } = await buildHarness();
    const body = paymentIntentSucceededEvent();
    grantPlanCredits.mockRejectedValueOnce(new Error("credit ledger unavailable"));

    const first = await service.handle(ORG, body, sign(body));
    const retry = await service.handle(ORG, body, sign(body));

    expect(first.status).toBe(500);
    expect(retry.status).toBe(200);
    expect(grantPlanCredits).toHaveBeenCalledTimes(2);
  });

  it("does not write a second subscription payment when it resumes", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const body = paymentIntentSucceededEvent();
    grantPlanCredits.mockRejectedValueOnce(new Error("credit ledger unavailable"));

    await service.handle(ORG, body, sign(body));
    await service.handle(ORG, body, sign(body));

    expect(ledger.subscriptionPayments).toHaveLength(1);
    expect(ledger.payments.size).toBe(1);
  });

  it("a third delivery after the resume succeeded is a plain duplicate", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const body = paymentIntentSucceededEvent();
    grantPlanCredits.mockRejectedValueOnce(new Error("credit ledger unavailable"));

    await service.handle(ORG, body, sign(body));
    await service.handle(ORG, body, sign(body));
    const third = await service.handle(ORG, body, sign(body));

    expect(third.body).toMatchObject({ duplicate: true });
    expect(grantPlanCredits).toHaveBeenCalledTimes(2);
    expect(ledger.subscriptionPayments).toHaveLength(1);
  });
});

describe("Stripe platform webhook — deliveries out of order", () => {
  /**
   * A declined attempt and its successful retry are two events on ONE intent,
   * and they race. Suspending on the failure that lands second suspends a
   * tenant who has paid.
   */
  it("does not suspend a paid tenant when a stale failure arrives afterwards", async () => {
    const { service, ledger } = await buildHarness();
    const paid = paymentIntentSucceededEvent();
    const failed = paymentIntentFailedEvent();

    await service.handle(ORG, paid, sign(paid));
    await service.handle(ORG, failed, sign(failed));

    expect(ledger.subscription?.status).toBe("ACTIVE");
    expect(ledger.payments.get(STRIPE_FIXTURE.intentId)?.status).toBe("captured");
  });

  it("suspends when the failure is all there is", async () => {
    const { service, ledger } = await buildHarness();
    const paid = paymentIntentSucceededEvent();
    const failed = paymentIntentFailedEvent();

    await service.handle(ORG, paid, sign(paid));
    ledger.subscriptionPayments.length = 0;
    ledger.payments.clear();
    await service.handle(ORG, failed, sign(failed));

    expect(ledger.subscription?.status).toBe("PAST_DUE");
  });

  /**
   * Refund before payment. Impossible in reality, entirely possible in delivery
   * order -- and the expensive direction to get wrong, because it hands out a
   * subscription for money that has already gone back.
   */
  it("refuses to credit a sale whose refund arrived first", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const refund = chargeRefundedEvent();
    const paid = paymentIntentSucceededEvent();

    await service.handle(ORG, refund, sign(refund));
    await service.handle(ORG, paid, sign(paid));

    expect(ledger.subscriptionPayments).toHaveLength(0);
    expect(ledger.subscription).toBeNull();
    expect(grantPlanCredits).not.toHaveBeenCalled();
  });

  it("leaves the payment refunded when the success lands after the refund", async () => {
    const { service, ledger } = await buildHarness();
    const refund = chargeRefundedEvent();
    const paid = paymentIntentSucceededEvent();

    await service.handle(ORG, refund, sign(refund));
    await service.handle(ORG, paid, sign(paid));

    expect(ledger.payments.get(STRIPE_FIXTURE.intentId)?.status).toBe("refunded");
  });
});

describe("Stripe platform webhook — refunds and the balance", () => {
  it("marks the payment refunded and nets the ledger to zero", async () => {
    const { service, ledger } = await buildHarness();
    const paid = paymentIntentSucceededEvent();
    const refund = chargeRefundedEvent();

    await service.handle(ORG, paid, sign(paid));
    expect(ledger.netCollectedMinor()).toBe(STRIPE_FIXTURE.amountMinor);

    await service.handle(ORG, refund, sign(refund));

    expect(ledger.payments.get(STRIPE_FIXTURE.intentId)).toMatchObject({ status: "refunded" });
    expect(ledger.netCollectedMinor()).toBe(0);
  });

  it("leaves a partial refund captured, and nets only what came back", async () => {
    const { service, ledger } = await buildHarness();
    const paid = paymentIntentSucceededEvent();
    const partial = chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 });

    await service.handle(ORG, paid, sign(paid));
    await service.handle(ORG, partial, sign(partial));

    expect(ledger.payments.get(STRIPE_FIXTURE.intentId)).toMatchObject({ status: "captured" });
    expect(ledger.netCollectedMinor()).toBe(STRIPE_FIXTURE.amountMinor - 50_000);
  });

  it("does not credit a subscription from a refund event", async () => {
    const { service, ledger } = await buildHarness();
    const partial = chargeRefundedEvent({ refunded: false, amount_refunded: 50_000 });

    await service.handle(ORG, partial, sign(partial));

    expect(ledger.subscriptionPayments).toHaveLength(0);
  });

  it("a redelivered refund does not double-count what came back", async () => {
    const { service, ledger } = await buildHarness();
    const paid = paymentIntentSucceededEvent();
    const refund = chargeRefundedEvent();

    await service.handle(ORG, paid, sign(paid));
    await service.handle(ORG, refund, sign(refund));
    await service.handle(ORG, refund, sign(refund));

    expect(ledger.netCollectedMinor()).toBe(0);
    expect(ledger.payments.size).toBe(1);
  });
});

describe("Stripe platform webhook — a delivery that is not genuine", () => {
  it("refuses a forged signature and writes nothing at all", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    const result = await service.handle(ORG, body, "t=1,v1=deadbeef");

    expect(result.status).toBe(401);
    expect(ledger.events.size).toBe(0);
    expect(ledger.payments.size).toBe(0);
    expect(ledger.subscriptionPayments).toHaveLength(0);
  });

  it("refuses a body signed with the wrong secret", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    const result = await service.handle(ORG, body, sign(body, "whsec_somebody_elses"));

    expect(result.status).toBe(401);
    expect(ledger.subscriptionPayments).toHaveLength(0);
  });

  /**
   * A captured delivery replayed outside the tolerance window.
   *
   * The timestamp is inside the signature, so this body and this header are
   * genuinely Stripe's -- they are simply too old to still be a claim about now.
   */
  it("refuses a genuine delivery replayed after the tolerance window", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();
    const longAgo = Math.floor(Date.now() / 1000) - REPLAY_TOLERANCE_SECONDS - 60;

    const result = await service.handle(ORG, body, sign(body, WEBHOOK_SECRET, longAgo));

    expect(result.status).toBe(401);
    expect(ledger.subscriptionPayments).toHaveLength(0);
  });

  /**
   * The tenant is the one in the URL; metadata may only contradict it.
   *
   * A delivery whose metadata names another organisation is a misrouted endpoint
   * or a valid signature from another deployment. Neither belongs to this org.
   */
  it("refuses a delivery whose metadata names a different organisation", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    const result = await service.handle("org-somebody-else", body, sign(body));

    expect(result.status).toBe(400);
    expect(ledger.events.size).toBe(0);
    expect(ledger.subscriptionPayments).toHaveLength(0);
  });

  it("refuses a body that is not a Stripe event, without recording it", async () => {
    const { service, ledger } = await buildHarness();
    const body = JSON.stringify({ hello: "world" });

    const result = await service.handle(ORG, body, sign(body));

    expect(result.status).toBe(400);
    expect(ledger.events.size).toBe(0);
  });
});

describe("Stripe platform webhook — deployment and payload edges", () => {
  it("asks for a retry rather than refusing when Stripe is not configured", async () => {
    const { service, ledger } = await buildHarness({} as AppConfig);
    const body = paymentIntentSucceededEvent();

    const result = await service.handle(ORG, body, sign(body));

    // 503, not 401: an unconfigured deployment should see the delivery again
    // once it is configured. A bad signature never becomes good.
    expect(result.status).toBe(503);
    expect(ledger.events.size).toBe(0);
  });

  it("acknowledges an event type it does not act on, without recording it", async () => {
    const { service, ledger } = await buildHarness();
    const body = JSON.stringify({
      id: "evt_unhandled_1",
      object: "event",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", object: "subscription" } },
    });

    const result = await service.handle(ORG, body, sign(body));

    expect(result.body).toMatchObject({ ok: true, ignored: "customer.subscription.updated" });
    expect(ledger.events.size).toBe(0);
  });

  /**
   * A payment that is not a subscription is recorded, not guessed at.
   *
   * The plan comes from the side that took the money. An intent without one is
   * a charge for something else, and inventing a tier from an amount is how a
   * STARTER buyer ends up on ENTERPRISE.
   */
  it("records a captured payment carrying no plan without crediting a subscription", async () => {
    const { service, ledger, grantPlanCredits } = await buildHarness();
    const body = paymentIntentSucceededEvent({ metadata: { orgId: ORG } });

    const result = await service.handle(ORG, body, sign(body));

    expect(result.status).toBe(200);
    expect(ledger.payments.size).toBe(1);
    expect(ledger.subscriptionPayments).toHaveLength(0);
    expect(grantPlanCredits).not.toHaveBeenCalled();
  });

  it("stamps the event processed once it has been applied", async () => {
    const { service, ledger } = await buildHarness();
    const body = paymentIntentSucceededEvent();

    await service.handle(ORG, body, sign(body));

    expect(ledger.events.get("evt_3MtwBwLkdIwHu7ix0lSgLRRb")?.processedAt).toBeInstanceOf(Date);
  });
});

/** Whole months between now and a date, which is what a cycle buys. */
function monthsFromNow(end: Date): number {
  const now = new Date();
  return (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth());
}
