import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { type RevenueEventInput } from "./revenue-events";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { normalizedPaymentWebhookEventSchema, type PaymentWebhookPayment, type NormalizedPaymentWebhookEvent } from "../payments/dto/webhook.schemas";
import { ProviderEventLedger, type ProviderEventKey } from "./provider-event-ledger";
import { BillingPaymentState } from "./billing-payment-state";

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export interface BillingWebhookDeps {
  db: Db;
  aiCredits: AiCreditsService;
  planLimits: PlanLimitsService;
  revenueAnalytics: RevenueAnalyticsService;
  providers: PaymentProviderResolver;
  externalEffectLedger: ExternalEffectLedger;
  paymentWebhooks: PaymentWebhookReceiverService;
  paymentNotices: PaymentAnalyticsService;
}

// Record, act, then acknowledge. A collaborator, not a provider — nothing outside billing resolves it.
export class BillingWebhookHandler {
  private readonly ledger: ProviderEventLedger;
  private readonly state: BillingPaymentState;

  constructor(private readonly deps: BillingWebhookDeps) {
    this.ledger = new ProviderEventLedger(deps.db);
    this.state = new BillingPaymentState(deps.db, deps.planLimits);
  }

  async handle(
    orgId: string,
    providerKey: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    const adapter = await this.deps.providers.resolve(orgId, providerKey);
    if (!adapter) {
      logger.warn("[billing] no payment provider registered for webhook verification");
      return { status: 503, body: { ok: false } };
    }
    if (!adapter.verifyWebhookSignature({ rawBody, signature })) {
      // Reported through the same channel the primary receiver uses, not just a log line.
      logger.warn(`[billing:${providerKey}] invalid webhook signature`);
      await this.deps.paymentWebhooks.recordSignatureFailure(orgId, providerKey);
      return { status: 401, body: { ok: false } };
    }

    const normalized = adapter.normalizeWebhook(rawBody);
    if (!normalized.ok) {
      const error = normalized.error === "invalid_json" ? "invalid JSON" : "invalid payload";
      return { status: 400, body: { ok: false, error } };
    }

    const parsed = normalizedPaymentWebhookEventSchema.safeParse({
      event: normalized.eventType,
      payload: normalized.payload,
    });
    if (!parsed.success) {
      logger.warn(`[billing:${providerKey}] normalized webhook payload validation failed`, {
        issues: parsed.error.issues,
      });
      return { status: 400, body: { ok: false, error: "invalid payload" } };
    }
    const event: NormalizedPaymentWebhookEvent = parsed.data;

    const payment = event.payload.payment?.entity;
    if (!payment) return { status: 200, body: { ok: true, ignored: event.event } };

    const key: ProviderEventKey = {
      orgId,
      providerKey,
      providerEventId: normalized.providerEventId ?? payment.id,
    };
    const claim = await this.ledger.claim(key, { eventType: event.event, rawBody });
    if (claim === "ERROR") return { status: 500, body: { ok: false } };
    if (claim === "PROCESSED") {
      logger.warn(`[billing:${providerKey}] duplicate event ignored`, key);
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (claim === "FOREIGN") {
      logger.error(`[billing:${providerKey}] event id already recorded against another tenant`, key);
      return { status: 409, body: { ok: false, error: "event already recorded" } };
    }

    const org = await this.state.findOrgFromNotes(payment.notes);
    if (org && org.id !== orgId) {
      logger.warn(`[billing:${providerKey}] webhook organization does not match endpoint organization`);
      return { status: 400, body: { ok: false, error: "organization mismatch" } };
    }
    const resolvedOrgId = org?.id ?? orgId;

    try {
      await this.state.persistPayment(payment, resolvedOrgId);
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to persist payment`, { error });
      return { status: 500, body: { ok: false } };
    }

    const applied = await this.applyEffects(event, payment, resolvedOrgId, providerKey);
    if (!applied.ok) return applied.result;

    // Success is claimed only here: the revenue events and the processed_at stamp commit together.
    try {
      await runInNewTenantTransaction(this.deps.db, orgId, async (tx) => {
        for (const entry of applied.revenue) await this.deps.revenueAnalytics.emit(tx, entry);
        await this.ledger.acknowledge(tx, key);
      });
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to acknowledge the provider event`, { error, ...key });
      await this.notifyProvisioningFailure(
        orgId,
        payment.id,
        "your payment was received but its billing effects have not completed",
      );
      return { status: 500, body: { ok: false } };
    }

    return { status: 200, body: { ok: true } };
  }

  listProvisioningFailures(orgId: string) {
    return this.ledger.listUnprocessed(orgId);
  }

  private async applyEffects(
    event: NormalizedPaymentWebhookEvent,
    payment: PaymentWebhookPayment,
    orgId: string,
    providerKey: string,
  ): Promise<{ ok: true; revenue: RevenueEventInput[] } | { ok: false; result: WebhookResult }> {
    const revenue: RevenueEventInput[] = [];
    const packId = packIdFor(event, payment);

    if (packId !== null) {
      try {
        await this.deps.externalEffectLedger.execute(
          {
            organizationId: orgId,
            producerEventId: payment.id,
            effectKey: `${payment.id}:pack-credit-grant`,
            effectType: "billing.ai-pack-credit-grant",
            providerIdempotency: "NONE",
          },
          () => this.deps.aiCredits.grantAiPackCreditsFromWebhook(orgId, packId, payment.id),
        );
        revenue.push({
          type: "addon_purchase",
          orgId,
          mrr: 0,
          amount: payment.amount,
          metadata: { paymentId: payment.id, packId, source: "provider-webhook" },
        });
      } catch (err: unknown) {
        if (err instanceof ExternalEffectLeaseBusyError)
          return { ok: false, result: { status: 503, body: { ok: false, error: "grant in-flight" } } };
        logger.error(`[billing:${providerKey}] ai pack credit grant failed`, {
          orgId,
          packId,
          paymentId: payment.id,
          err,
        });
        await this.notifyProvisioningFailure(
          orgId,
          payment.id,
          "the AI credits you purchased could not be added",
        );
        return { ok: false, result: { status: 500, body: { ok: false } } };
      }
    }

    if (event.event === "payment.failed" && payment.status === "failed") {
      try {
        await this.state.transitionToPastDue(orgId, payment.id);
      } catch (err: unknown) {
        logger.error(`[billing:${providerKey}] PAST_DUE transition failed`, {
          orgId,
          paymentId: payment.id,
          err,
        });
        return { ok: false, result: { status: 500, body: { ok: false } } };
      }
    }

    if (payment.status === "refunded") {
      revenue.push({
        type: "refund",
        orgId,
        mrr: 0,
        amount: payment.amount,
        metadata: { paymentId: payment.id, source: "provider-webhook" },
      });
    }

    return { ok: true, revenue };
  }

  // Through the effect ledger so a retrying provider produces one message, not a stream.
  private async notifyProvisioningFailure(
    orgId: string,
    paymentId: string,
    detail: string,
  ): Promise<void> {
    try {
      await this.deps.externalEffectLedger.execute(
        {
          organizationId: orgId,
          producerEventId: paymentId,
          effectKey: `${paymentId}:provisioning-failure-notice`,
          effectType: "billing.provisioning-failure-notice",
          providerIdempotency: "NONE",
        },
        () =>
          runInNewTenantTransaction(this.deps.db, orgId, () =>
            this.deps.paymentNotices.notifyOwner(orgId, {
              title: "Payment received — provisioning is still pending",
              message: `${detail}. We are retrying automatically; contact support if this does not clear shortly.`,
              type: "WARNING",
              priority: "HIGH",
              link: "/settings/billing",
            }),
          ),
      );
    } catch (err: unknown) {
      if (err instanceof ExternalEffectLeaseBusyError) return;
      logger.error("[billing] could not tell the organisation about a provisioning failure", {
        orgId,
        paymentId,
        err,
      });
    }
  }
}

function packIdFor(event: NormalizedPaymentWebhookEvent, payment: PaymentWebhookPayment): number | null {
  if (event.event !== "payment.captured" || payment.status !== "captured") return null;
  if (!payment.notes?.packId) return null;
  const packId = parseInt(String(payment.notes.packId), 10);
  return isNaN(packId) ? null : packId;
}
