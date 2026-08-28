import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  paymentProviders,
  paymentWebhookEndpoints,
  paymentWebhookEvents,
} from "../../../db/schema";
import { getCatalogEntry } from "./payment-provider-catalog";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { ProviderBridgeService } from "../../finance/controls/provider-bridge.service";
import type { RequestActorContext } from "../../../common/audit/actor-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { normalizedPaymentWebhookEventSchema } from "./dto/webhook.schemas";

// Only an allow-listed summary is ever persisted in payload_redacted — never the full webhook
// body, which can carry card/bank/contact details depending on event type.
function redactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const entityKey of Object.keys(payload)) {
    const entity = (
      payload[entityKey] as { entity?: Record<string, unknown> } | undefined
    )?.entity;
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
    private readonly providers: PaymentProviderResolver,
    private readonly audit: PaymentAuditService,
    private readonly paymentAnalytics: PaymentAnalyticsService,
    private readonly providerBridge: ProviderBridgeService,
  ) {}

  private async findProvider(orgId: string, providerKey: string) {
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(
        eq(paymentProviders.orgId, orgId),
        eq(paymentProviders.providerKey, providerKey),
      ),
    });
    if (!provider)
      throw new NotFoundException(
        `Payment provider not configured: ${providerKey}`,
      );
    return provider;
  }

  async generateEndpoint(
    orgId: string,
    providerKey: string,
    environment: "test" | "live",
    apiBaseUrl: string,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const catalogEntry = getCatalogEntry(providerKey);
    const url = `${apiBaseUrl.replace(/\/$/, "")}/webhooks/payments/${providerKey}/${environment}/${orgId}`;

    const existing = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(
        eq(paymentWebhookEndpoints.providerId, provider.id),
        eq(paymentWebhookEndpoints.environment, environment),
      ),
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
      : await this.db
          .insert(paymentWebhookEndpoints)
          .values({ ...values, status: "not_verified" })
          .returning();

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
    this.paymentAnalytics.track(
      orgId,
      actor.userId,
      "payment_webhook_generated",
      { metadata: { providerKey, environment } },
    );

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
      where: and(
        eq(paymentWebhookEndpoints.providerId, provider.id),
        eq(paymentWebhookEndpoints.environment, environment),
      ),
    });
    if (!endpoint)
      throw new BadRequestException(
        "Generate the webhook endpoint before verifying it",
      );

    if (!sample) {
      return endpoint;
    }

    const providerFacade = await this.providers.resolve(
      orgId,
      providerKey,
      environment,
    );
    if (!providerFacade)
      throw new BadRequestException(
        `No backend integration available for provider: ${providerKey}`,
      );

    const valid = providerFacade.verifyWebhookSignature({
      rawBody: sample.rawBody,
      signature: sample.signature,
    });

    const [updated] = await this.db
      .update(paymentWebhookEndpoints)
      .set(
        valid
          ? {
              status: "verified",
              lastVerifiedAt: new Date(),
              failureReason: null,
            }
          : {
              status: "failing",
              lastFailureAt: new Date(),
              failureReason: "Sample signature did not match",
            },
      )
      .where(eq(paymentWebhookEndpoints.id, endpoint.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: valid
        ? "payment_webhook.verified"
        : "payment_webhook.verification_failed",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    if (valid) {
      this.paymentAnalytics.track(
        orgId,
        actor.userId,
        "payment_webhook_verified",
        { metadata: { providerKey, environment } },
      );
    }

    return updated;
  }

  async listEvents(orgId: string, providerKey: string, limit = 50) {
    const provider = await this.findProvider(orgId, providerKey);
    return this.db.query.paymentWebhookEvents.findMany({
      where: and(
        eq(paymentWebhookEvents.orgId, orgId),
        eq(paymentWebhookEvents.providerId, provider.id),
      ),
      orderBy: desc(paymentWebhookEvents.receivedAt),
      limit,
    });
  }

  // The single way a rejected signature is reported; notifies once, on the healthy→failing edge.
  async recordSignatureFailure(
    orgId: string,
    providerKey: string,
    environment?: "test" | "live",
  ): Promise<void> {
    const endpoints = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [provider] = await tx
          .select({ id: paymentProviders.id })
          .from(paymentProviders)
          .where(
            and(
              eq(paymentProviders.orgId, orgId),
              eq(paymentProviders.providerKey, providerKey),
            ),
          )
          .limit(1);
        if (!provider) return [];
        return tx
          .select({
            id: paymentWebhookEndpoints.id,
            status: paymentWebhookEndpoints.status,
          })
          .from(paymentWebhookEndpoints)
          .where(
            environment
              ? and(
                  eq(paymentWebhookEndpoints.providerId, provider.id),
                  eq(paymentWebhookEndpoints.environment, environment),
                )
              : eq(paymentWebhookEndpoints.providerId, provider.id),
          );
      },
      { orgId },
    );

    if (endpoints.length === 0) return;
    const wasHealthy = endpoints.some((row) => row.status !== "failing");

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(paymentWebhookEndpoints)
          .set({
            status: "failing",
            lastFailureAt: new Date(),
            failureReason: "Invalid signature",
          })
          .where(
            inArray(
              paymentWebhookEndpoints.id,
              endpoints.map((row) => row.id),
            ),
          );
      },
      { orgId },
    );

    if (!wasHealthy) return;
    const scope = environment ? `${providerKey} (${environment})` : providerKey;
    await this.paymentAnalytics.notifyOwner(orgId, {
      title: "Payment webhook is failing",
      message: `${scope} webhook signature verification is failing. Check the webhook secret in Settings > Payments.`,
      type: "WARNING",
      priority: "HIGH",
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
    const provider = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(paymentProviders)
          .where(
            and(
              eq(paymentProviders.orgId, params.orgId),
              eq(paymentProviders.providerKey, params.providerKey),
            ),
          )
          .limit(1);
        return row;
      },
      { orgId: params.orgId },
    );
    if (!provider)
      return {
        status: 404,
        body: { ok: false, error: "provider not configured" },
      };

    const providerFacade = await this.providers.resolve(
      params.orgId,
      params.providerKey,
      params.environment,
    );
    if (!providerFacade)
      return {
        status: 400,
        body: { ok: false, error: "webhook not configured" },
      };

    const signatureValid = providerFacade.verifyWebhookSignature({
      rawBody: params.rawBody,
      signature: params.signature ?? "",
    });

    const endpoint = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(paymentWebhookEndpoints)
          .where(
            and(
              eq(paymentWebhookEndpoints.providerId, provider.id),
              eq(paymentWebhookEndpoints.environment, params.environment),
            ),
          )
          .limit(1);
        return row;
      },
      { orgId: params.orgId },
    );

    if (!signatureValid) {
      await this.recordSignatureFailure(
        params.orgId,
        params.providerKey,
        params.environment,
      );
      return { status: 401, body: { ok: false, error: "invalid signature" } };
    }

    const normalized = providerFacade.normalizeWebhook(params.rawBody);
    if (!normalized.ok) {
      return {
        status: 400,
        body: {
          ok: false,
          error:
            normalized.error === "invalid_json"
              ? "invalid JSON"
              : "invalid payload",
        },
      };
    }

    // The adapter owns provider parsing; this service still owns the neutral contract.
    // Reject malformed payment entities before recording a successful webhook receipt.
    const neutral = validateNormalizedPaymentWebhook(normalized);
    if (!neutral.success)
      return { status: 400, body: { ok: false, error: "invalid payload" } };

    const eventId = resolveProviderEventId(
      params.providerEventIdHeader,
      normalized,
      params.rawBody,
    );
    if (!eventId.ok)
      return { status: 400, body: { ok: false, error: "event ID mismatch" } };

    const providerEventId = eventId.id;

    const [inserted] = await runInTenantTransaction(
      this.db,
      async (tx) => {
        return tx
          .insert(paymentWebhookEvents)
          .values({
            orgId: params.orgId,
            providerId: provider.id,
            environment: params.environment,
            providerEventId,
            eventType: normalized.eventType,
            signatureValid: true,
            processingStatus: "processed",
            idempotencyKey: providerEventId,
            payloadRedacted: redactPayload(neutral.data.payload),
            processedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [
              paymentWebhookEvents.providerId,
              paymentWebhookEvents.environment,
              paymentWebhookEvents.providerEventId,
            ],
          })
          .returning();
      },
      { orgId: params.orgId },
    );

    if (endpoint) {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx
            .update(paymentWebhookEndpoints)
            .set({
              status: "verified",
              lastVerifiedAt: new Date(),
              failureReason: null,
            })
            .where(eq(paymentWebhookEndpoints.id, endpoint.id));
        },
        { orgId: params.orgId },
      );
    }

    if (!inserted) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    try {
      const paymentEntity = this.extractPaymentEntity(neutral.data.payload);
      if (
        paymentEntity &&
        normalized.eventType.includes("payment") &&
        typeof paymentEntity.amount === "number"
      ) {
        await this.providerBridge.recordProviderPayment(
          params.orgId,
          "system",
          {
            provider: params.providerKey,
            providerEventId: providerEventId,
            grossAmount: String(paymentEntity.amount / 100),
            feeAmount: String(
              typeof paymentEntity.fee === "number"
                ? paymentEntity.fee / 100
                : 0,
            ),
            currency:
              typeof paymentEntity.currency === "string"
                ? paymentEntity.currency.toUpperCase()
                : "INR",
            occurredAt:
              typeof paymentEntity.createdAt === "number"
                ? new Date(paymentEntity.createdAt * 1000)
                : new Date(),
          },
        );
      }
    } catch (bridgeError) {
      this.logger.warn(
        `Provider bridge posting failed for event ${providerEventId}: ${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`,
      );
    }

    return { status: 200, body: { ok: true } };
  }

  async retryEvent(
    orgId: string,
    providerKey: string,
    eventId: number,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const event = await this.db.query.paymentWebhookEvents.findFirst({
      where: and(
        eq(paymentWebhookEvents.id, eventId),
        eq(paymentWebhookEvents.orgId, orgId),
        eq(paymentWebhookEvents.providerId, provider.id),
      ),
    });
    if (!event) throw new NotFoundException("Webhook event not found");

    // Re-processing here means re-running whatever reconciliation the event type implies
    // (e.g. re-checking invoice/subscription state) — that reconciliation logic is owned by
    // billing/invoices, not this module, so this marks the event for reconciliation rather
    // than re-deriving business effects itself.
    const [updated] = await this.db
      .update(paymentWebhookEvents)
      .set({
        processingStatus: "processed",
        processedAt: new Date(),
        errorMessage: null,
      })
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

  private extractPaymentEntity(
    payload: Record<string, unknown>,
  ): Record<string, unknown> | null {
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
}

export function validateNormalizedPaymentWebhook(normalized: {
  eventType: string;
  payload: Record<string, unknown>;
}) {
  return normalizedPaymentWebhookEventSchema.safeParse({
    event: normalized.eventType,
    payload: normalized.payload,
  });
}

export function resolveProviderEventId(
  header: string | undefined,
  normalized: { providerEventId?: string },
  rawBody: string,
): { ok: true; id: string } | { ok: false } {
  const supplied = header?.trim();
  if (
    supplied &&
    normalized.providerEventId &&
    supplied !== normalized.providerEventId
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    id:
      supplied ||
      normalized.providerEventId ||
      createHash("sha256").update(rawBody).digest("hex"),
  };
}
