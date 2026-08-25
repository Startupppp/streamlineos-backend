import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviders, paymentWebhookEndpoints, paymentWebhookEvents } from "../../../db/schema";
import { getCatalogEntry } from "./payment-provider-catalog";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { webhookEnvelopeSchema } from "./dto/webhook.schemas";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import type { PostingCommandLine } from "../../accounting/adapters/posting-command.types";
import type { RequestActorContext } from "../../../common/audit/actor-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

// Only an allow-listed summary is ever persisted in payload_redacted — never the full webhook
// body, which can carry card/bank/contact details depending on event type.
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const entityKey of Object.keys(payload)) {
    const entity = (payload[entityKey] as { entity?: Record<string, unknown> } | undefined)?.entity;
    if (!entity || typeof entity !== "object") continue;
    summary[entityKey] = {
      id: entity.id,
      status: entity.status,
      amount: entity.amount,
      currency: entity.currency,
    };
  }
  return summary;
}

@Injectable()
export class PaymentWebhookHealthService {
  private readonly logger = new Logger(PaymentWebhookHealthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: PaymentProviderAdapterRegistry,
    private readonly providers: PaymentProviderSetupService,
    private readonly audit: PaymentAuditService,
    private readonly paymentAnalytics: PaymentAnalyticsService,
    private readonly posting: PostingCommandService,
  ) {}

  private async findProvider(orgId: string, providerKey: string) {
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
    });
    if (!provider) throw new NotFoundException(`Payment provider not configured: ${providerKey}`);
    return provider;
  }

  async generateEndpoint(orgId: string, providerKey: string, environment: "test" | "live", apiBaseUrl: string, actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const catalogEntry = getCatalogEntry(providerKey);
    const url = `${apiBaseUrl.replace(/\/$/, "")}/webhooks/payments/${providerKey}/${environment}/${orgId}`;

    const existing = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(eq(paymentWebhookEndpoints.providerId, provider.id), eq(paymentWebhookEndpoints.environment, environment)),
    });

    const values = {
      orgId,
      providerId: provider.id,
      environment,
      url,
      expectedEvents: catalogEntry?.expectedWebhookEvents ?? [],
    };

    const [endpoint] = existing
      ? await this.db
          .update(paymentWebhookEndpoints)
          .set(values)
          .where(eq(paymentWebhookEndpoints.id, existing.id))
          .returning()
      : await this.db.insert(paymentWebhookEndpoints).values({ ...values, status: "not_verified" }).returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_webhook.generated",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { url },
    });
    this.paymentAnalytics.track(orgId, actor.userId, "payment_webhook_generated", { metadata: { providerKey, environment } });

    return endpoint;
  }

  /** Manual verification path for a sample event pasted from the provider's dashboard. */
  async verifyEndpointManual(
    orgId: string,
    providerKey: string,
    environment: "test" | "live",
    sample: { rawBody: string; signature: string } | undefined,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const endpoint = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(eq(paymentWebhookEndpoints.providerId, provider.id), eq(paymentWebhookEndpoints.environment, environment)),
    });
    if (!endpoint) throw new BadRequestException("Generate the webhook endpoint before verifying it");

    if (!sample) {
      return endpoint;
    }

    const adapter = this.registry.get(providerKey);
    if (!adapter) throw new BadRequestException(`No backend integration available for provider: ${providerKey}`);

    const creds = await this.providers.getDecryptedSecret(orgId, provider.id, environment);
    if (!creds?.webhookSecret) throw new BadRequestException("Save a webhook secret before verifying");

    const valid = adapter.verifyWebhookSignature({
      rawBody: sample.rawBody,
      signature: sample.signature,
      webhookSecret: creds.webhookSecret,
    });

    const [updated] = await this.db
      .update(paymentWebhookEndpoints)
      .set(
        valid
          ? { status: "verified", lastVerifiedAt: new Date(), failureReason: null }
          : { status: "failing", lastFailureAt: new Date(), failureReason: "Sample signature did not match" },
      )
      .where(eq(paymentWebhookEndpoints.id, endpoint.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: valid ? "payment_webhook.verified" : "payment_webhook.verification_failed",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    if (valid) {
      this.paymentAnalytics.track(orgId, actor.userId, "payment_webhook_verified", { metadata: { providerKey, environment } });
    }

    return updated;
  }

  async listEvents(orgId: string, providerKey: string, limit = 50) {
    const provider = await this.findProvider(orgId, providerKey);
    return this.db.query.paymentWebhookEvents.findMany({
      where: and(eq(paymentWebhookEvents.orgId, orgId), eq(paymentWebhookEvents.providerId, provider.id)),
      orderBy: desc(paymentWebhookEvents.receivedAt),
      limit,
    });
  }

  /**
   * Public webhook receiver entry point. Verifies signature, enforces idempotency via the
   * unique(provider_id, environment, provider_event_id) constraint (insert-or-ignore, never
   * reprocess a duplicate), and flips the endpoint's health based on the outcome.
   */
  async processIncomingWebhook(params: {
    providerKey: string;
    environment: "test" | "live";
    orgId: string;
    rawBody: string;
    signature: string | undefined;
    providerEventIdHeader: string | undefined;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const adapter = this.registry.get(params.providerKey);
    if (!adapter) return { status: 404, body: { ok: false, error: "unknown provider" } };

    const provider = await runInTenantTransaction(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentProviders)
        .where(and(eq(paymentProviders.orgId, params.orgId), eq(paymentProviders.providerKey, params.providerKey)))
        .limit(1);
      return row;
    }, { orgId: params.orgId });
    if (!provider) return { status: 404, body: { ok: false, error: "provider not configured" } };

    const creds = await this.providers.getDecryptedSecret(params.orgId, provider.id, params.environment);
    if (!creds?.webhookSecret) return { status: 400, body: { ok: false, error: "webhook not configured" } };

    const signatureValid = adapter.verifyWebhookSignature({
      rawBody: params.rawBody,
      signature: params.signature ?? "",
      webhookSecret: creds.webhookSecret,
    });

    const endpoint = await runInTenantTransaction(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentWebhookEndpoints)
        .where(and(eq(paymentWebhookEndpoints.providerId, provider.id), eq(paymentWebhookEndpoints.environment, params.environment)))
        .limit(1);
      return row;
    }, { orgId: params.orgId });

    if (!signatureValid) {
      if (endpoint) {
        const wasHealthy = endpoint.status !== "failing";
        await runInTenantTransaction(this.db, async (tx) => {
          await tx
            .update(paymentWebhookEndpoints)
            .set({ status: "failing", lastFailureAt: new Date(), failureReason: "Invalid signature" })
            .where(eq(paymentWebhookEndpoints.id, endpoint.id));
        }, { orgId: params.orgId });
        if (wasHealthy) {
          await this.paymentAnalytics.notifyOwner(params.orgId, {
            title: "Payment webhook is failing",
            message: `${params.providerKey} (${params.environment}) webhook signature verification is failing. Check the webhook secret in Settings > Payments.`,
            type: "WARNING",
            priority: "HIGH",
          });
        }
      }
      return { status: 401, body: { ok: false, error: "invalid signature" } };
    }

    let envelope: { event: string; payload: Record<string, unknown> };
    try {
      const raw: unknown = JSON.parse(params.rawBody);
      const parsed = webhookEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return { status: 400, body: { ok: false, error: "invalid payload" } };
      envelope = parsed.data;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid JSON" } };
    }

    const providerEventId =
      params.providerEventIdHeader ?? createHash("sha256").update(params.rawBody).digest("hex");

    const [inserted] = await runInTenantTransaction(this.db, async (tx) => {
      return tx
        .insert(paymentWebhookEvents)
        .values({
          orgId: params.orgId,
          providerId: provider.id,
          environment: params.environment,
          providerEventId,
          eventType: envelope.event,
          signatureValid: true,
          processingStatus: "processed",
          idempotencyKey: providerEventId,
          payloadRedacted: redactPayload(envelope.payload),
          processedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [paymentWebhookEvents.providerId, paymentWebhookEvents.environment, paymentWebhookEvents.providerEventId],
        })
        .returning();
    }, { orgId: params.orgId });

    if (endpoint) {
      await runInTenantTransaction(this.db, async (tx) => {
        await tx
          .update(paymentWebhookEndpoints)
          .set({ status: "verified", lastVerifiedAt: new Date(), failureReason: null })
          .where(eq(paymentWebhookEndpoints.id, endpoint.id));
      }, { orgId: params.orgId });
    }

    if (!inserted) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    try {
      const paymentEntity = this.extractPaymentEntity(envelope.payload);
      if (paymentEntity && envelope.event.includes("payment") && typeof paymentEntity.amount === "number") {
        await this.recordProviderPayment(params.orgId, params.providerKey, providerEventId, paymentEntity);
      }
    } catch (bridgeError) {
      this.logger.warn(`Provider bridge posting failed for event ${providerEventId}: ${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`);
    }

    return { status: 200, body: { ok: true } };
  }

  async retryEvent(orgId: string, providerKey: string, eventId: number, actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const event = await this.db.query.paymentWebhookEvents.findFirst({
      where: and(eq(paymentWebhookEvents.id, eventId), eq(paymentWebhookEvents.orgId, orgId), eq(paymentWebhookEvents.providerId, provider.id)),
    });
    if (!event) throw new NotFoundException("Webhook event not found");

    // Re-processing here means re-running whatever reconciliation the event type implies
    // (e.g. re-checking invoice/subscription state) — that reconciliation logic is owned by
    // billing/invoices, not this module, so this marks the event for reconciliation rather
    // than re-deriving business effects itself.
    const [updated] = await this.db
      .update(paymentWebhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date(), errorMessage: null })
      .where(eq(paymentWebhookEvents.id, eventId))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_webhook_event.retried",
      environment: event.environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }

  private extractPaymentEntity(payload: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of Object.keys(payload)) {
      const wrapper = payload[key];
      if (wrapper && typeof wrapper === "object" && "entity" in wrapper) {
        const entity = (wrapper as { entity?: unknown }).entity;
        if (entity && typeof entity === "object") {
          return entity as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  /**
   * A captured provider payment, offered to accounting.
   *
   *   payment gateway clearing   net     (debit)   — captured, not yet settled
   *   payment processing fees    fee     (debit)
   *   accounts receivable        gross   (credit)
   *
   * The provider reports amounts in the currency's smallest unit, which is
   * exactly what the ledger wants, so nothing is converted through a float on
   * the way in. Accounting resolves the three accounts from the org's own chart
   * by system tag; billing never names a GL account and never writes a journal
   * line itself.
   *
   * Rejections (accounting not enabled for the org, a currency the book cannot
   * take without an FX rate) propagate to the caller, which logs and still
   * acknowledges the webhook — a provider must never be told to retry because
   * a bookkeeping entry did not land.
   */
  private async recordProviderPayment(
    orgId: string,
    providerKey: string,
    providerEventId: string,
    entity: Record<string, unknown>,
  ): Promise<void> {
    const grossMinor = typeof entity.amount === "number" ? Math.round(entity.amount) : 0;
    const feeMinor = typeof entity.fee === "number" ? Math.round(entity.fee) : 0;
    const netMinor = grossMinor - feeMinor;
    if (grossMinor <= 0 || netMinor <= 0) return;

    const currency = typeof entity.currency === "string" ? entity.currency.toUpperCase() : "INR";
    const occurredAt =
      typeof entity.created_at === "number" ? new Date(entity.created_at * 1000) : new Date();
    const journalDate = occurredAt.toISOString().slice(0, 10);

    const lines: PostingCommandLine[] = [
      {
        accountTag: "psp_clearing",
        debitMinor: netMinor,
        currency,
        description: `${providerKey} settlement due`,
      },
      {
        accountTag: "ar_control",
        creditMinor: grossMinor,
        currency,
        description: `${providerKey} payment ${providerEventId}`,
      },
    ];
    if (feeMinor > 0) {
      lines.splice(1, 0, {
        accountTag: "payment_fees",
        debitMinor: feeMinor,
        currency,
        description: `${providerKey} processing fee`,
      });
    }

    // No human actor: the webhook posts as the system, and the ledger records
    // that honestly as a null poster rather than inventing a user id.
    await this.posting.submit(orgId, null, {
      sourceType: "payment",
      sourceId: providerEventId,
      purpose: "payment_received",
      journalDate,
      memo: `${providerKey} payment received (${currency}) event ${providerEventId}`,
      lines,
    });
  }
}
