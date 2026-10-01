import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  integrationWebhookEndpointCredentials,
  integrationWebhookDeliveries,
} from "../../../db/schema/integrations/webhook-delivery";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import {
  postSafeWebhook,
  UnsafeWebhookTargetError,
} from "../../../common/outbound/safe-webhook-transport";
import {
  callProvider,
  type ProviderCallResult,
  type ProviderDescriptor,
} from "../../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../../common/outbound/provider-circuit-breaker";

export const INTEGRATIONS_WEBHOOK_DELIVERY_EVENT =
  "integrations.webhook.delivery.requested";

const WEBHOOK_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2000;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 5;

export const MISSING_SIGNING_SECRET_ERROR =
  "Endpoint has no signing secret; delivery refused because an empty key makes the signature forgeable. Re-create the webhook to mint a secret.";

interface DeliveryRow {
  deliveryId: number;
  event: string;
  payload: unknown;
  status: string;
  credentialId: number | null;
  targetUrl: string;
  signingSecret: string | null;
}

interface DeliveryOutcome {
  responseCode: number | null;
  responseBody: string | null;
  success: boolean;
  lastError: string | null;
  attempts: number;
}

class WebhookResponseError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`HTTP ${statusCode}`);
    this.name = "WebhookResponseError";
  }
}

function classifyWebhookError(error: unknown): "terminal" | "retryable" {
  if (!(error instanceof WebhookResponseError)) return "retryable";
  if ([408, 425, 429].includes(error.statusCode)) return "retryable";
  return error.statusCode >= 400 && error.statusCode < 500 ? "terminal" : "retryable";
}

function outcomeFromProviderResult(
  result: ProviderCallResult<{ statusCode: number; responseBody: string }>,
): DeliveryOutcome {
  if (result.ok)
    return {
      responseCode: result.value.statusCode,
      responseBody: result.value.responseBody,
      success: true,
      lastError: null,
      attempts: result.attempts,
    };

  if (result.kind === "circuit-open")
    return {
      responseCode: null,
      responseBody: null,
      success: false,
      lastError: `Circuit open; retry after ${result.retryAfterMs}ms`,
      attempts: result.attempts,
    };

  const responseError =
    result.error instanceof WebhookResponseError ? result.error : null;
  return {
    responseCode: responseError?.statusCode ?? null,
    responseBody: responseError?.responseBody ?? null,
    success: false,
    lastError:
      result.kind === "dead-lettered"
        ? `Dead after ${result.attempts} attempts: ${result.error.message}`
        : result.error.message,
    attempts: result.attempts,
  };
}

@Injectable()
export class WebhookDeliveryService implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = INTEGRATIONS_WEBHOOK_DELIVERY_EVENT;
  private readonly breaker = new ProviderCircuitBreaker();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly registry?: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const raw = event.payload;
    const deliveryId =
      typeof raw === "object" && raw !== null ? Reflect.get(raw, "deliveryId") : undefined;
    if (
      typeof deliveryId !== "number" ||
      !Number.isSafeInteger(deliveryId) ||
      deliveryId <= 0
    )
      throw new Error("Invalid integrations webhook delivery outbox payload");
    await this.processDelivery(event.organizationId, deliveryId);
  }

  private async processDelivery(orgId: string, deliveryId: number): Promise<void> {
    const rows = await this.db
      .select({
        deliveryId: integrationWebhookDeliveries.id,
        event: integrationWebhookDeliveries.event,
        payload: integrationWebhookDeliveries.payload,
        status: integrationWebhookDeliveries.status,
        credentialId: integrationWebhookDeliveries.credentialId,
        targetUrl: integrationWebhookDeliveries.targetUrl,
        signingSecret: integrationWebhookEndpointCredentials.signingSecret,
      })
      .from(integrationWebhookDeliveries)
      .leftJoin(
        integrationWebhookEndpointCredentials,
        and(
          eq(
            integrationWebhookDeliveries.credentialId,
            integrationWebhookEndpointCredentials.id,
          ),
          eq(
            integrationWebhookDeliveries.orgId,
            integrationWebhookEndpointCredentials.orgId,
          ),
        ),
      )
      .where(
        and(
          eq(integrationWebhookDeliveries.orgId, orgId),
          eq(integrationWebhookDeliveries.id, deliveryId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row || row.status === "success") return;

    const outcome = await this.deliverPayload(row, deliveryId);
    await this.persistOutcome(orgId, deliveryId, outcome);

    if (!outcome.success) {
      const responseError =
        outcome.responseCode !== null
          ? new WebhookResponseError(outcome.responseCode, outcome.responseBody ?? "")
          : null;
      if (responseError !== null && classifyWebhookError(responseError) === "retryable")
        throw responseError;
      if (
        outcome.lastError &&
        !outcome.lastError.startsWith("Blocked webhook target") &&
        outcome.lastError !== MISSING_SIGNING_SECRET_ERROR &&
        !outcome.lastError.startsWith("Circuit open")
      )
        throw new Error(outcome.lastError);
    }
  }

  private async deliverPayload(row: DeliveryRow, deliveryId: number): Promise<DeliveryOutcome> {
    if (!row.signingSecret)
      return {
        responseCode: null,
        responseBody: null,
        success: false,
        lastError: MISSING_SIGNING_SECRET_ERROR,
        attempts: 0,
      };

    const body = JSON.stringify({
      event: row.event,
      data: row.payload ?? {},
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", row.signingSecret).update(body).digest("hex");

    const descriptor: ProviderDescriptor = {
      provider: `integrations-webhook:${row.credentialId ?? deliveryId}`,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: WEBHOOK_BASE_DELAY_MS,
      maxDelayMs: WEBHOOK_MAX_DELAY_MS,
      classify: classifyWebhookError,
    };

    const result = await callProvider(
      descriptor,
      async () => {
        try {
          const response = await postSafeWebhook(
            row.targetUrl,
            body,
            {
              "Content-Type": "application/json",
              "X-StreamlineOS-Signature": `sha256=${signature}`,
              "X-Webhook-Event": row.event,
              "X-StreamlineOS-Delivery-Id": String(deliveryId),
            },
            WEBHOOK_TIMEOUT_MS,
            RESPONSE_BODY_LIMIT,
          );
          if (response.statusCode < 200 || response.statusCode >= 300)
            throw new WebhookResponseError(response.statusCode, response.responseBody);
          return response;
        } catch (error) {
          if (error instanceof UnsafeWebhookTargetError)
            throw new WebhookResponseError(400, error.message);
          throw error;
        }
      },
      this.breaker,
    );

    return outcomeFromProviderResult(result);
  }

  private async persistOutcome(
    orgId: string,
    deliveryId: number,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    await this.db
      .update(integrationWebhookDeliveries)
      .set({
        status: outcome.success ? "success" : "failed",
        responseCode: outcome.responseCode,
        responseBody: outcome.responseBody?.slice(0, RESPONSE_BODY_LIMIT) ?? null,
        attempts: sql`${integrationWebhookDeliveries.attempts} + ${outcome.attempts}`,
        lastError: outcome.lastError,
        deliveredAt: new Date(),
      })
      .where(
        and(
          eq(integrationWebhookDeliveries.orgId, orgId),
          eq(integrationWebhookDeliveries.id, deliveryId),
        ),
      );
  }
}
