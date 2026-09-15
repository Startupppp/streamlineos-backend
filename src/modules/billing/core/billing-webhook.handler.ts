import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../../common/logger/logger.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { normalizedPaymentWebhookEventSchema, type PaymentWebhookPayment, type NormalizedPaymentWebhookEvent } from "../payments/dto/webhook.schemas";
import { ProviderEventLedger, type ProviderEventKey } from "./provider-event-ledger";
import { BillingPaymentState } from "./billing-payment-state";
import { BillingWebhookEffects, type WebhookResult } from "./billing-webhook-effects";
import { BillingPaymentActivation } from "./billing-payment-activation";
import { SubscriptionPurchaseService } from "./subscription-purchase.service";
import { PlatformMerchantService } from "../payments/platform-merchant.service";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";

export type { WebhookResult };

export interface BillingWebhookDeps {
  db: Db;
  aiCredits: AiCreditsService;
  planLimits: PlanLimitsService;
  revenueAnalytics: RevenueAnalyticsService;
  providers: PaymentProviderResolver;
  externalEffectLedger: ExternalEffectLedger;
  paymentWebhooks: PaymentWebhookReceiverService;
  paymentNotices: PaymentAnalyticsService;
  platformMerchant: PlatformMerchantService;
  activation: BillingPaymentActivation;
}

@Injectable()
export class BillingWebhookHandler {
  private readonly ledger: ProviderEventLedger;
  private readonly state: BillingPaymentState;
  private readonly effects: BillingWebhookEffects;
  private readonly purchaseService: SubscriptionPurchaseService;
  private readonly deps: BillingWebhookDeps;

  constructor(
    @Inject(DRIZZLE) db: Db,
    aiCredits: AiCreditsService,
    planLimits: PlanLimitsService,
    revenueAnalytics: RevenueAnalyticsService,
    providers: PaymentProviderResolver,
    externalEffectLedger: ExternalEffectLedger,
    paymentWebhooks: PaymentWebhookReceiverService,
    paymentNotices: PaymentAnalyticsService,
    platformMerchant: PlatformMerchantService,
    activation: BillingPaymentActivation,
  ) {
    this.deps = { db, aiCredits, planLimits, revenueAnalytics, providers, externalEffectLedger, paymentWebhooks, paymentNotices, platformMerchant, activation };
    this.ledger = new ProviderEventLedger(db);
    this.state = new BillingPaymentState(db, planLimits);
    this.purchaseService = new SubscriptionPurchaseService(db);
    this.effects = new BillingWebhookEffects(
      {
        db,
        aiCredits,
        externalEffectLedger,
        paymentNotices,
        activation,
      },
      this.state,
    );
  }

  async handle(
    orgId: string,
    providerKey: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    const adapter = this.deps.platformMerchant.resolve();

    if (!adapter) {
      logger.warn("[billing] no payment provider registered for webhook verification");
      return { status: 503, body: { ok: false } };
    }
    if (!adapter.verifyWebhookSignature({ rawBody, signature })) {
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

    let effectiveOrgId = orgId;
    if (payment.orderId) {
      const purchaseOrgId = await this.purchaseService.findOrgIdByOrderId(this.deps.db, payment.orderId);
      if (purchaseOrgId !== null) effectiveOrgId = purchaseOrgId;
    }
    if (effectiveOrgId === orgId) {
      const org = await this.state.findOrgFromNotes(payment.notes);
      if (org !== null) effectiveOrgId = org.id;
    }

    const key: ProviderEventKey = {
      orgId: effectiveOrgId,
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

    return this.settle(event, payment, effectiveOrgId, providerKey, key);
  }

  async redriveUnprocessed(
    orgId: string,
    window: { minAgeMs: number; maxAgeMs: number; limit: number },
    now = new Date(),
  ): Promise<{ attempted: number; recovered: number; failed: number }> {
    const rows = await this.ledger.listRedrivable(orgId, window, now);
    let recovered = 0;
    let failed = 0;

    for (const row of rows) {
      const adapter = this.deps.platformMerchant.resolve();

      if (!adapter) {
        failed += 1;
        continue;
      }
      const normalized = adapter.normalizeWebhook(JSON.stringify(row.rawPayload));
      if (!normalized.ok) {
        failed += 1;
        continue;
      }
      const parsed = normalizedPaymentWebhookEventSchema.safeParse({
        event: normalized.eventType,
        payload: normalized.payload,
      });
      const payment = parsed.success ? parsed.data.payload.payment?.entity : undefined;
      if (!parsed.success || !payment) {
        failed += 1;
        continue;
      }
      const result = await this.settle(parsed.data, payment, orgId, row.provider, {
        orgId,
        providerKey: row.provider,
        providerEventId: row.providerEventId,
      });
      if (result.status === 200) recovered += 1;
      else failed += 1;
    }

    return { attempted: rows.length, recovered, failed };
  }

  listProvisioningFailures(orgId: string) {
    return this.ledger.listUnprocessed(orgId);
  }

  private async reconcileFromNotes(
    payment: PaymentWebhookPayment,
    orgId: string,
    providerKey: string,
  ): Promise<SubscriptionPurchase | null> {
    const orderId = payment.orderId;
    const rawPurchaseId = payment.notes?.purchaseId;
    if (!orderId || !rawPurchaseId) return null;
    const purchaseId = parseInt(rawPurchaseId, 10);
    if (isNaN(purchaseId)) return null;

    const found = await this.purchaseService.findById(this.deps.db, purchaseId, orgId);
    if (!found) return null;

    const readiness = this.deps.platformMerchant.readiness();
    const currentEnv = this.deps.platformMerchant.environment();
    if (
      !readiness.configured ||
      readiness.publicKeyId === null ||
      found.merchantKeyId !== readiness.publicKeyId ||
      found.environment !== currentEnv ||
      found.amountMinor !== payment.amount ||
      found.currency !== payment.currency
    ) {
      logger.warn(`[billing:${providerKey}] reconciled purchase failed integrity check`, {
        orgId,
        purchaseId,
      });
      return null;
    }

    if (found.providerOrderId === null) {
      const attached = await this.deps.db.transaction(
        async (tx) => this.purchaseService.attachProviderOrder(tx, found.id, orgId, orderId),
      );
      if (attached !== null) return attached;

      const refetched = await this.purchaseService.findById(this.deps.db, purchaseId, orgId);
      if (!refetched || refetched.providerOrderId !== orderId) {
        logger.warn(`[billing:${providerKey}] reconciled purchase already carries a different order`, {
          orgId,
          purchaseId,
        });
        return null;
      }
      return refetched;
    }

    if (found.providerOrderId !== orderId) {
      logger.warn(`[billing:${providerKey}] reconciled purchase carries a different order id`, {
        orgId,
        purchaseId,
      });
      return null;
    }

    return found;
  }

  private async settle(
    event: NormalizedPaymentWebhookEvent,
    payment: PaymentWebhookPayment,
    orgId: string,
    providerKey: string,
    key: ProviderEventKey,
  ): Promise<WebhookResult> {
    let purchase: SubscriptionPurchase | null = null;
    let effectiveOrgId = orgId;
    const orderId = payment.orderId;
    if (orderId) {
      const purchaseOrgId = await this.purchaseService.findOrgIdByOrderId(this.deps.db, orderId);
      if (purchaseOrgId !== null) {
        effectiveOrgId = purchaseOrgId;
        purchase = await runInNewTenantTransaction(this.deps.db, effectiveOrgId, (tx) =>
          this.purchaseService.findByOrderId(tx, orderId),
        );
      }
    }

    if (purchase === null) {
      const org = await this.state.findOrgFromNotes(payment.notes);
      if (org !== null) effectiveOrgId = org.id;
    }

    if (purchase === null && orderId !== undefined) {
      purchase = await runInNewTenantTransaction(this.deps.db, effectiveOrgId, async () =>
        this.reconcileFromNotes(payment, effectiveOrgId, providerKey),
      );
    }

    try {
      await this.state.persistPayment(payment, effectiveOrgId);
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to persist payment`, { error });
      return { status: 500, body: { ok: false } };
    }

    const applied = await this.effects.apply(event, payment, effectiveOrgId, providerKey, purchase);
    if (!applied.ok) return applied.result;

    try {
      await runInNewTenantTransaction(this.deps.db, effectiveOrgId, async (tx) => {
        for (const entry of applied.revenue) await this.deps.revenueAnalytics.emit(tx, entry);
        await this.ledger.acknowledge(tx, key);
      });
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to acknowledge the provider event`, { error, ...key });
      await this.effects.notifyProvisioningFailure(
        effectiveOrgId,
        payment.id,
        "your payment was received but its billing effects have not completed",
      );
      return { status: 500, body: { ok: false } };
    }

    return { status: 200, body: { ok: true } };
  }
}
