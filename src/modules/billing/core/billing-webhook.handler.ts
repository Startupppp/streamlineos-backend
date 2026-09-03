import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
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
}

// Record, act, then acknowledge. A collaborator, not a provider — nothing outside billing resolves it.
export class BillingWebhookHandler {
  private readonly ledger: ProviderEventLedger;
  private readonly state: BillingPaymentState;
  private readonly effects: BillingWebhookEffects;

  constructor(private readonly deps: BillingWebhookDeps) {
    this.ledger = new ProviderEventLedger(deps.db);
    this.state = new BillingPaymentState(deps.db, deps.planLimits);
    this.effects = new BillingWebhookEffects(deps, this.state);
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

    return this.settle(event, payment, orgId, providerKey, key);
  }

  /**
   * Re-drives events the provider stopped retrying. The signature was verified when the row was
   * recorded, so the stored payload is trusted here; nothing outside the ledger enters this path.
   */
  async redriveUnprocessed(
    orgId: string,
    window: { minAgeMs: number; maxAgeMs: number; limit: number },
    now = new Date(),
  ): Promise<{ attempted: number; recovered: number; failed: number }> {
    const rows = await this.ledger.listRedrivable(orgId, window, now);
    let recovered = 0;
    let failed = 0;

    for (const row of rows) {
      const adapter = await this.deps.providers.resolve(orgId, row.provider);
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

  private async settle(
    event: NormalizedPaymentWebhookEvent,
    payment: PaymentWebhookPayment,
    orgId: string,
    providerKey: string,
    key: ProviderEventKey,
  ): Promise<WebhookResult> {
    /*
     * Both entrances converge here, which is why the guard lives here and not in `handle`.
     *
     * It used to sit in `handle` alone, and `handle` returns the 400 AFTER `ledger.claim`
     * has written the row and BEFORE anything stamps `processed_at`. `listRedrivable`
     * selects on exactly `processed_at IS NULL` plus an age window, so the refused row was
     * a redrive candidate `minAgeMs` later — and `redriveUnprocessed` settled it with no
     * notes check, persisting another tenant's payment under this org and granting this org
     * the credits from `notes.packId`.
     *
     * On the live path this is behaviour-preserving: `handle` already refused any mismatch,
     * so the `resolvedOrgId = org?.id ?? orgId` it used to compute was always `orgId`.
     */
    const org = await this.state.findOrgFromNotes(payment.notes);
    if (org && org.id !== orgId) {
      logger.warn(`[billing:${providerKey}] webhook organization does not match endpoint organization`);
      return { status: 400, body: { ok: false, error: "organization mismatch" } };
    }

    try {
      await this.state.persistPayment(payment, orgId);
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to persist payment`, { error });
      return { status: 500, body: { ok: false } };
    }

    const applied = await this.effects.apply(event, payment, orgId, providerKey);
    if (!applied.ok) return applied.result;

    // Success is claimed only here: the revenue events and the processed_at stamp commit together.
    try {
      await runInNewTenantTransaction(this.deps.db, key.orgId, async (tx) => {
        for (const entry of applied.revenue) await this.deps.revenueAnalytics.emit(tx, entry);
        await this.ledger.acknowledge(tx, key);
      });
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to acknowledge the provider event`, { error, ...key });
      await this.effects.notifyProvisioningFailure(
        key.orgId,
        payment.id,
        "your payment was received but its billing effects have not completed",
      );
      return { status: 500, body: { ok: false } };
    }

    return { status: 200, body: { ok: true } };
  }

}
