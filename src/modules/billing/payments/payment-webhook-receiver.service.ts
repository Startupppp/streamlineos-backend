import {
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  paymentProviders,
  paymentWebhookEndpoints,
  paymentWebhookEvents,
} from "../../../db/schema";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { ProviderBridgeService } from "../../finance/controls/provider-bridge.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { normalizedPaymentWebhookEventSchema } from "./dto/webhook.schemas";

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
export class PaymentWebhookReceiverService {
  private readonly logger = new Logger(PaymentWebhookReceiverService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly providers: PaymentProviderResolver,
    private readonly paymentAnalytics: PaymentAnalyticsService,
    private readonly providerBridge: ProviderBridgeService,
  ) {}

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
                  eq(paymentWebhookEndpoints.orgId, orgId),
                  eq(paymentWebhookEndpoints.providerId, provider.id),
                  eq(paymentWebhookEndpoints.environment, environment),
                )
              : and(
                  eq(paymentWebhookEndpoints.orgId, orgId),
                  eq(paymentWebhookEndpoints.providerId, provider.id),
                ),
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
              eq(paymentWebhookEndpoints.orgId, params.orgId),
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
    } catch (err: unknown) {
      // The event is already recorded, so a retry would short-circuit as a duplicate and never
      // re-run the bridge. Mark the row failed instead so the webhook health surface shows it.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Finance bridge did not record the provider payment", {
        orgId: params.orgId,
        providerKey: params.providerKey,
        providerEventId,
        cause: message,
      });
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx
            .update(paymentWebhookEvents)
            .set({ processingStatus: "failed", errorMessage: message.slice(0, 1000) })
            .where(
              and(
                eq(paymentWebhookEvents.orgId, params.orgId),
                eq(paymentWebhookEvents.id, inserted.id),
              ),
            );
        },
        { orgId: params.orgId },
      );
    }

    return { status: 200, body: { ok: true } };
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
