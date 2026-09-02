import { logger } from "../../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { type Db } from "../../../db/drizzle.module";
import { AiCreditsService } from "./ai-credits.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { type RevenueEventInput } from "./revenue-events";
import {
  type PaymentWebhookPayment,
  type NormalizedPaymentWebhookEvent,
} from "../payments/dto/webhook.schemas";
import { BillingPaymentState } from "./billing-payment-state";

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export type EffectOutcome =
  | { ok: true; revenue: RevenueEventInput[] }
  | { ok: false; result: WebhookResult };

export interface BillingWebhookEffectDeps {
  db: Db;
  aiCredits: AiCreditsService;
  externalEffectLedger: ExternalEffectLedger;
  paymentNotices: PaymentAnalyticsService;
}

export function packIdFor(
  event: NormalizedPaymentWebhookEvent,
  payment: PaymentWebhookPayment,
): number | null {
  if (event.event !== "payment.captured" || payment.status !== "captured") return null;
  if (!payment.notes?.packId) return null;
  const packId = parseInt(String(payment.notes.packId), 10);
  return isNaN(packId) ? null : packId;
}

// What a verified payment does to the tenant's billing state, isolated from the webhook transport.
export class BillingWebhookEffects {
  constructor(
    private readonly deps: BillingWebhookEffectDeps,
    private readonly state: BillingPaymentState,
  ) {}

  async apply(
    event: NormalizedPaymentWebhookEvent,
    payment: PaymentWebhookPayment,
    orgId: string,
    providerKey: string,
  ): Promise<EffectOutcome> {
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
  async notifyProvisioningFailure(
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
