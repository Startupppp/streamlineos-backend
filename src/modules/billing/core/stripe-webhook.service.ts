import { Inject, Injectable } from "@nestjs/common";
import { logger } from "../../../common/logger/logger.service";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { billingCycleSchema, planSchema, type BillingCycle } from "./dto/billing.schemas";
import { translateStripeEvent, type StripePlatformPayment } from "./stripe-platform-events";
import { planStripeWebhook } from "./stripe-webhook-decision";
import {
  STRIPE_PROVIDER_KEY,
  StripeWebhookLedger,
  type StripeWebhookLedgerPort,
} from "./stripe-webhook-ledger";

export interface StripeWebhookResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * The confirmation half of the Stripe adapter.
 *
 * Razorpay hands the browser an `order|payment` HMAC that the return trip
 * verifies, so `verifyAndActivate` can activate a subscription synchronously.
 * Stripe has no such client signature -- `StripeService.verifyPaymentSignature`
 * returns false, deliberately, because treating its absence as success would
 * accept an unverified return. **The webhook is therefore not a nicety for
 * Stripe, it is the only path by which a Stripe payment ever activates
 * anything**, and a browser that never comes back still credits the tenant.
 *
 */
@Injectable()
export class StripePlatformWebhookService {
  constructor(
    private readonly registry: PlatformPaymentRegistry,
    /*
      The token is the Drizzle class; the type is the port it satisfies. A
      private field makes a class structurally unsubstitutable, and the whole
      point of the port is that a test can supply a store whose uniqueness rules
      are real and whose contents can be counted afterwards.
    */
    @Inject(StripeWebhookLedger)
    private readonly ledger: StripeWebhookLedgerPort,
    private readonly aiCredits: AiCreditsService,
    private readonly planLimits: PlanLimitsService,
    private readonly effects: ExternalEffectLedger,
  ) {}

  async handle(orgId: string, rawBody: string, signature: string): Promise<StripeWebhookResult> {
    /*
      The PLATFORM's Stripe credentials, not the tenant's. This direction is us
      billing them, and its secret is `STRIPE_WEBHOOK_SECRET` on the deployment.
      Verifying a platform delivery against a tenant-held secret would let a
      tenant who has connected their own Stripe account sign their own
      subscription payments.
    */
    const stripe = this.registry.byProviderKey(STRIPE_PROVIDER_KEY);
    if (!stripe || !stripe.isConfigured()) {
      logger.warn("[billing:stripe] webhook received but Stripe is not configured");
      return { status: 503, body: { ok: false } };
    }

    // 503 rather than 401 above, and 401 here: an unconfigured deployment should
    // have the delivery retried once it is configured; a bad signature never
    // becomes good.
    if (!stripe.verifyWebhookSignature(rawBody, signature)) {
      logger.warn("[billing:stripe] invalid webhook signature");
      return { status: 401, body: { ok: false } };
    }

    const translated = translateStripeEvent(rawBody);
    if (!translated.ok) return { status: 400, body: { ok: false, error: translated.reason } };
    if (translated.kind === "ignored") {
      /*
        Acknowledged and not recorded. An endpoint subscribed to everything sees
        hundreds of types; keeping them out of the dedupe table keeps that table
        about the events that move money, and reprocessing a no-op is free.
      */
      return { status: 200, body: { ok: true, ignored: translated.eventType } };
    }

    const payment = translated.payment;

    /*
      The tenant is the one in the URL, and metadata may only contradict it.

      `createOrder` stamps `orgId` into the intent's metadata, so a delivery
      whose metadata names a different organisation is either a misrouted
      endpoint or a forgery with a valid signature from another deployment.
      Neither should be applied to the tenant named in the path.
    */
    const notedOrg = payment.notes.orgId ?? payment.notes.org_id;
    if (notedOrg && notedOrg !== orgId) {
      logger.warn("[billing:stripe] webhook organisation does not match endpoint organisation");
      return { status: 400, body: { ok: false, error: "organization mismatch" } };
    }

    try {
      const recording = await this.ledger.recordEvent(orgId, {
        eventId: payment.eventId,
        eventType: payment.eventType,
        rawPayload: JSON.parse(rawBody),
      });
      if (recording === "duplicate") {
        logger.warn("[billing:stripe] duplicate event ignored", { eventId: payment.eventId });
        return { status: 200, body: { ok: true, duplicate: true } };
      }
      if (recording === "resume")
        logger.warn("[billing:stripe] resuming a delivery that did not finish", {
          eventId: payment.eventId,
        });
    } catch (error: unknown) {
      logger.error("[billing:stripe] failed to record provider event", { orgId, error });
      return { status: 500, body: { ok: false } };
    }

    const now = new Date();
    try {
      const state = await this.ledger.readState(orgId, payment.intentId);
      const plan = planStripeWebhook(payment, state);

      await this.ledger.persistPayment(orgId, {
        intentId: payment.intentId,
        chargeId: payment.chargeId,
        outcome: plan.outcome,
        amountMinor: payment.amountMinor,
        amountRefundedMinor: plan.amountRefundedMinor,
        currency: payment.currency,
        email: payment.email,
        notes: payment.notes,
      });

      if (plan.creditSubscription) await this.creditSubscription(orgId, payment, now);

      if (plan.markPastDue) await this.ledger.markPastDue(orgId, payment.intentId, now);

      await this.ledger.markEventProcessed(orgId, payment.eventId, now);
      return { status: 200, body: { ok: true } };
    } catch (error: unknown) {
      if (error instanceof ExternalEffectLeaseBusyError)
        return { status: 503, body: { ok: false, error: "grant in-flight" } };
      logger.error("[billing:stripe] webhook application failed", {
        orgId,
        eventId: payment.eventId,
        error,
      });
      // 500 so Stripe retries. The event row stays unprocessed, and every step
      // above is keyed, so the retry resumes rather than repeats.
      return { status: 500, body: { ok: false } };
    }
  }

  /**
   * Turns a captured intent into a subscription, once.
   *
   * The plan and the cycle come from the intent's metadata, which is what the
   * side that took the money holds -- never from anything the browser said. An
   * intent with no plan on it is a payment for something that is not a
   * subscription (or a hand-made charge), and is recorded without crediting one
   * rather than guessed at.
   */
  private async creditSubscription(
    orgId: string,
    payment: StripePlatformPayment,
    at: Date,
  ): Promise<void> {
    const plan = planSchema.safeParse(payment.notes.plan);
    if (!plan.success) {
      logger.info("[billing:stripe] captured payment carries no plan; recorded only", {
        orgId,
        intentId: payment.intentId,
      });
      return;
    }

    const cycle = billingCycleSchema.safeParse(payment.notes.billingCycle);
    const billingCycle: BillingCycle = cycle.success ? cycle.data : "monthly";

    const result = await this.ledger.creditSubscription(orgId, {
      intentId: payment.intentId,
      plan: plan.data,
      billingCycle,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      at,
    });

    // Only a genuinely new credit invalidates the plan-limit cache.
    if (result.credited) await this.planLimits.bust(orgId);

    /*
      The grant runs whether or not THIS delivery wrote the subscription payment.

      Returning early on `credited: false` is the tempting shape and it loses
      money: a delivery that died after the row was written but before the grant
      would find the row on retry, conclude there was nothing to do, and the
      tenant would have paid for credits they never received. The effect ledger
      is what makes running it again free.

      Keyed on the INTENT rather than the event, because two different Stripe
      events can both mean "this sale completed" and the `evt_` dedupe cannot
      see that. The intent is the identity of the purchase.
    */
    await this.effects.execute(
      {
        organizationId: orgId,
        producerEventId: payment.intentId,
        effectKey: `${payment.intentId}:plan-credit-grant`,
        effectType: "billing.plan-credit-grant",
        providerIdempotency: "NONE",
      },
      () => this.aiCredits.grantPlanCredits(orgId, plan.data, undefined, payment.intentId),
    );
  }
}
