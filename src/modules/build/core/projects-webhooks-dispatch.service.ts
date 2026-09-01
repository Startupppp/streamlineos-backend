import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { projectWebhooks, webhookDeliveries } from "../../../db/schema/build/tasks";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
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

const WEBHOOK_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;
const WEBHOOK_OUTBOX_EVENT = "build.project-webhook.delivery.requested";

export interface WebhookPayload extends Record<string, unknown> {
  id: number;
  projectId: number;
  actor: string;
  timestamp: string;
}

interface ActiveEndpoint {
  id: number;
  url: string;
  secret: string;
  orgId: string;
}

interface WebhookResponse {
  statusCode: number;
  responseBody: string;
}

interface DeliveryOutcome {
  responseCode: number | null;
  responseBody: string | null;
  success: boolean;
  lastError: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
}

export class ProjectWebhookResponseError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`HTTP ${statusCode}`);
    this.name = "ProjectWebhookResponseError";
  }
}

export function classifyProjectWebhookError(error: unknown): "terminal" | "retryable" {
  if (!(error instanceof ProjectWebhookResponseError)) return "retryable";
  if ([408, 425, 429].includes(error.statusCode)) return "retryable";
  return error.statusCode >= 400 && error.statusCode < 500 ? "terminal" : "retryable";
}

function outcomeFromProviderResult(
  result: ProviderCallResult<WebhookResponse>,
): DeliveryOutcome {
  if (result.ok)
    return {
      responseCode: result.value.statusCode,
      responseBody: result.value.responseBody,
      success: true,
      lastError: null,
      attempts: result.attempts,
      nextAttemptAt: null,
    };

  if (result.kind === "circuit-open")
    return {
      responseCode: null,
      responseBody: null,
      success: false,
      lastError: `Circuit open; retry after ${result.retryAfterMs}ms`,
      attempts: result.attempts,
      nextAttemptAt: null,
    };

  const responseError =
    result.error instanceof ProjectWebhookResponseError ? result.error : null;
  return {
    responseCode: responseError?.statusCode ?? null,
    responseBody: responseError?.responseBody ?? null,
    success: false,
    lastError:
      result.kind === "dead-lettered"
        ? `Dead after ${result.attempts} attempts: ${result.error.message}`
        : result.error.message,
    attempts: result.attempts,
    nextAttemptAt: null,
  };
}

@Injectable()
export class ProjectsWebhooksDispatchService implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = WEBHOOK_OUTBOX_EVENT;
  private readonly breaker = new ProviderCircuitBreaker();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly registry?: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async dispatch(orgId: string, projectId: number, eventName: string, payload: WebhookPayload): Promise<void> {
    await this.enqueue(orgId, projectId, eventName, payload);
  }

  private async enqueue(
    orgId: string,
    projectId: number,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    await runInTenantTransaction(this.db, async (tx) => {
      const rows = await tx
        .select({ id: projectWebhooks.id, events: projectWebhooks.events })
        .from(projectWebhooks)
        .where(and(
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
          eq(projectWebhooks.isActive, true),
        ));

      const active = rows.filter(({ events }) =>
        events.length === 0 || events.includes(eventName) || events.includes("*"),
      );
      for (const endpoint of active) {
        const [delivery] = await tx.insert(webhookDeliveries).values({
          orgId,
          webhookId: endpoint.id,
          event: eventName,
          payload,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
        }).returning({ id: webhookDeliveries.id });
        if (!delivery) throw new Error("Failed to persist project webhook delivery intent");
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "project_webhook_delivery",
          aggregateId: String(delivery.id),
          aggregateVersion: delivery.id,
          eventType: WEBHOOK_OUTBOX_EVENT,
          payload: { deliveryId: delivery.id },
          occurredAt: new Date(),
        });
      }
    }, { orgId });
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const deliveryId = typeof event.payload === "object" && event.payload !== null
      ? Reflect.get(event.payload, "deliveryId")
      : undefined;
    if (typeof deliveryId !== "number" || !Number.isSafeInteger(deliveryId) || deliveryId <= 0)
      throw new Error("Invalid project webhook delivery outbox payload");
    await this.processDelivery(event.organizationId, deliveryId);
  }

  private async processDelivery(
    orgId: string,
    deliveryId: number,
    throwRetryable = true,
  ): Promise<DeliveryOutcome | null> {
    const row = await this.db
      .select({
        deliveryId: webhookDeliveries.id,
        event: webhookDeliveries.event,
        payload: webhookDeliveries.payload,
        status: webhookDeliveries.status,
        endpointId: projectWebhooks.id,
        url: projectWebhooks.url,
        secret: projectWebhooks.secret,
        endpointOrgId: projectWebhooks.orgId,
      })
      .from(webhookDeliveries)
      .innerJoin(projectWebhooks, and(
        eq(projectWebhooks.id, webhookDeliveries.webhookId),
        eq(projectWebhooks.orgId, webhookDeliveries.orgId),
      ))
      .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.id, deliveryId)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!row || row.status === "success") return null;

    const outcome = await this.deliver(
      { id: row.endpointId, url: row.url, secret: row.secret ?? "", orgId: row.endpointOrgId },
      row.event,
      (row.payload ?? {}) as WebhookPayload,
      deliveryId,
    );
    await this.updateDelivery(orgId, deliveryId, outcome);
    if (!outcome.success && outcome.lastError && outcome.responseCode !== null) {
      const error = new ProjectWebhookResponseError(outcome.responseCode, outcome.responseBody ?? "");
      if (throwRetryable && classifyProjectWebhookError(error) === "retryable") throw error;
    } else if (throwRetryable && !outcome.success && !outcome.lastError?.startsWith("Blocked webhook target")) {
      throw new Error(outcome.lastError ?? "Project webhook delivery failed");
    }
    return outcome;
  }

  private async deliver(
    endpoint: ActiveEndpoint,
    eventName: string,
    payload: WebhookPayload,
    deliveryId: number,
  ): Promise<DeliveryOutcome> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret || "").update(body).digest("hex");

    const descriptor: ProviderDescriptor = {
      provider: `build-webhook:${endpoint.id}`,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      baseDelayMs: WEBHOOK_BASE_DELAY_MS,
      maxDelayMs: WEBHOOK_MAX_DELAY_MS,
      classify: classifyProjectWebhookError,
    };
    const result = await callProvider(
      descriptor,
      async () => {
        try {
          const response = await postSafeWebhook(endpoint.url, body, {
            "Content-Type": "application/json",
            "X-StreamlineOS-Signature": `sha256=${signature}`,
            "X-Webhook-Event": eventName,
            "X-StreamlineOS-Delivery-Id": String(deliveryId),
          }, WEBHOOK_TIMEOUT_MS, RESPONSE_BODY_LIMIT);
          if (response.statusCode < 200 || response.statusCode >= 300)
            throw new ProjectWebhookResponseError(response.statusCode, response.responseBody);
          return response;
        } catch (error) {
          if (error instanceof UnsafeWebhookTargetError)
            throw new ProjectWebhookResponseError(400, error.message);
          throw error;
        }
      },
      this.breaker,
    );
    const outcome = outcomeFromProviderResult(result);
    return outcome;
  }

  private async updateDelivery(
    orgId: string,
    deliveryId: number,
    outcome: DeliveryOutcome,
  ): Promise<void> {
      await this.db.update(webhookDeliveries).set({
        status: outcome.success ? "success" : "failed",
        responseCode: outcome.responseCode,
        responseBody: outcome.responseBody?.slice(0, RESPONSE_BODY_LIMIT) ?? null,
        attempts: sql`${webhookDeliveries.attempts} + ${outcome.attempts}`,
        lastError: outcome.lastError,
        nextAttemptAt: outcome.nextAttemptAt,
        deliveredAt: new Date(),
      }).where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.id, deliveryId)));
  }

  async sendTest(
    orgId: string,
    projectId: number,
    webhookId: number,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    const row = await this.db
      .select({
        id: projectWebhooks.id,
        url: projectWebhooks.url,
        secret: projectWebhooks.secret,
        orgId: projectWebhooks.orgId,
        projectId: projectWebhooks.projectId,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.id, webhookId),
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) return { success: false, responseCode: null };

    const testPayload: WebhookPayload = {
      id: webhookId,
      projectId,
      actor: "system",
      timestamp: new Date().toISOString(),
      message: "This is a test delivery from StreamlineOS.",
    };

    const deliveryId = await runInTenantTransaction(this.db, async (tx) => {
      const [delivery] = await tx.insert(webhookDeliveries).values({
        orgId,
        webhookId,
        event: "webhook.test",
        payload: testPayload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      }).returning({ id: webhookDeliveries.id });
      if (!delivery) throw new Error("Failed to persist test webhook delivery intent");
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "project_webhook_delivery",
        aggregateId: String(delivery.id),
        aggregateVersion: delivery.id,
        eventType: WEBHOOK_OUTBOX_EVENT,
        payload: { deliveryId: delivery.id },
        occurredAt: new Date(),
      });
      return delivery.id;
    }, { orgId });
    const outcome = await this.processDelivery(orgId, deliveryId, false);
    if (!outcome) return { success: true, responseCode: null };
    return { success: outcome.success, responseCode: outcome.responseCode };
  }
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
