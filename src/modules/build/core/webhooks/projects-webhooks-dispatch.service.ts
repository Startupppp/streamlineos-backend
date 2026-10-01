import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { projectWebhooks } from "../../../../db/schema/build/tasks";
import {
  integrationWebhookEndpointCredentials,
  integrationWebhookDeliveries,
} from "../../../../db/schema/integrations/webhook-delivery";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import {
  postSafeWebhook,
  UnsafeWebhookTargetError,
} from "../../../../common/outbound/safe-webhook-transport";
import { INTEGRATIONS_WEBHOOK_DELIVERY_EVENT } from "../../../integrations/core/webhook-delivery.service";

const INTERACTIVE_TIMEOUT_MS = 5_000;
const RESPONSE_BODY_LIMIT = 2000;

export const MISSING_SIGNING_SECRET_ERROR =
  "Endpoint has no signing secret; delivery refused because an empty key makes the signature forgeable. Re-create the webhook to mint a secret.";

export interface WebhookPayload extends Record<string, unknown> {
  id: number;
  projectId: number;
  actor: string;
  timestamp: string;
}

const LEGACY_OUTBOX_EVENT = "build.project-webhook.delivery.requested";

@Injectable()
export class ProjectsWebhooksDispatchService implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = LEGACY_OUTBOX_EVENT;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly registry?: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry?.register(this);
  }

  async handle(_event: OutboxEventRow): Promise<void> {
    // Legacy build.webhook_deliveries rows are no longer retried via this path.
    // Any pending rows from before the 1720-1723 migration can be cleared manually.
    // New deliveries flow through integrations.webhook.delivery.requested.
  }

  async dispatch(orgId: string, projectId: number, eventName: string, payload: WebhookPayload): Promise<void> {
    await runInTenantTransaction(
      this.db,
      (tx) => this.enqueue(tx, orgId, projectId, eventName, payload),
      { orgId },
    );
  }

  async enqueue(
    tx: DbOrTx,
    orgId: string,
    projectId: number,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const rows = await tx
      .select({
        id: projectWebhooks.id,
        events: projectWebhooks.events,
        url: projectWebhooks.url,
        integrationsEndpointId: projectWebhooks.integrationsEndpointId,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
          eq(projectWebhooks.isActive, true),
        ),
      );

    const active = rows.filter(
      (r) =>
        r.integrationsEndpointId !== null &&
        (r.events.length === 0 || r.events.includes(eventName) || r.events.includes("*")),
    );
    if (active.length === 0) return;

    const now = new Date();
    const deliveries = await tx
      .insert(integrationWebhookDeliveries)
      .values(
        active.map((ep) => ({
          orgId,
          credentialId: ep.integrationsEndpointId,
          buildWebhookId: ep.id,
          targetUrl: ep.url,
          event: eventName,
          payload,
          status: "pending" as const,
          attempts: 0,
          nextAttemptAt: now,
        })),
      )
      .returning({ id: integrationWebhookDeliveries.id });

    if (deliveries.length !== active.length)
      throw new Error("Failed to persist webhook delivery intent");

    await OutboxWriter.emitMany(
      tx,
      deliveries.map((d) => ({
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "integration_webhook_delivery",
        aggregateId: String(d.id),
        aggregateVersion: d.id,
        eventType: INTEGRATIONS_WEBHOOK_DELIVERY_EVENT,
        payload: { deliveryId: d.id, orgId },
        occurredAt: now,
      })),
    );
  }

  async sendTest(
    orgId: string,
    projectId: number,
    webhookId: number,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    const endpointRow = await this.db
      .select({
        id: projectWebhooks.id,
        url: projectWebhooks.url,
        orgId: projectWebhooks.orgId,
        integrationsEndpointId: projectWebhooks.integrationsEndpointId,
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

    if (!endpointRow) return { success: false, responseCode: null };

    const credentialRow = endpointRow.integrationsEndpointId
      ? await this.db
          .select({ signingSecret: integrationWebhookEndpointCredentials.signingSecret })
          .from(integrationWebhookEndpointCredentials)
          .where(
            and(
              eq(integrationWebhookEndpointCredentials.orgId, orgId),
              eq(integrationWebhookEndpointCredentials.id, endpointRow.integrationsEndpointId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0])
      : undefined;

    const signingSecret = credentialRow?.signingSecret ?? null;

    const testPayload: WebhookPayload = {
      id: webhookId,
      projectId,
      actor: "system",
      timestamp: new Date().toISOString(),
      message: "This is a test delivery from StreamlineOS.",
    };

    const deliveryId = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const now = new Date();
        const [delivery] = await tx
          .insert(integrationWebhookDeliveries)
          .values({
            orgId,
            credentialId: endpointRow.integrationsEndpointId,
            buildWebhookId: webhookId,
            targetUrl: endpointRow.url,
            event: "webhook.test",
            payload: testPayload,
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
          })
          .returning({ id: integrationWebhookDeliveries.id });
        if (!delivery) throw new Error("Failed to persist test webhook delivery intent");
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "integration_webhook_delivery",
          aggregateId: String(delivery.id),
          aggregateVersion: delivery.id,
          eventType: INTEGRATIONS_WEBHOOK_DELIVERY_EVENT,
          payload: { deliveryId: delivery.id, orgId },
          occurredAt: now,
        });
        return delivery.id;
      },
      { orgId },
    );

    const outcome = await this.deliverNow(
      orgId,
      deliveryId,
      endpointRow.url,
      signingSecret,
      "webhook.test",
      testPayload,
    );

    return { success: outcome.success, responseCode: outcome.responseCode };
  }

  private async deliverNow(
    orgId: string,
    deliveryId: number,
    url: string,
    signingSecret: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    if (!signingSecret) {
      await this.db
        .update(integrationWebhookDeliveries)
        .set({ status: "failed", lastError: MISSING_SIGNING_SECRET_ERROR })
        .where(
          and(
            eq(integrationWebhookDeliveries.orgId, orgId),
            eq(integrationWebhookDeliveries.id, deliveryId),
          ),
        );
      return { success: false, responseCode: null };
    }

    const body = JSON.stringify({
      event: eventName,
      data: payload,
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", signingSecret).update(body).digest("hex");

    let responseCode: number | null = null;
    let success = false;
    let lastError: string | null = null;

    try {
      const response = await postSafeWebhook(
        url,
        body,
        {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": `sha256=${signature}`,
          "X-Webhook-Event": eventName,
          "X-StreamlineOS-Delivery-Id": String(deliveryId),
        },
        INTERACTIVE_TIMEOUT_MS,
        RESPONSE_BODY_LIMIT,
      );
      responseCode = response.statusCode;
      success = response.statusCode >= 200 && response.statusCode < 300;
      if (!success) lastError = `HTTP ${response.statusCode}`;
    } catch (error) {
      if (error instanceof UnsafeWebhookTargetError) {
        lastError = error.message;
        responseCode = 400;
      } else {
        lastError = error instanceof Error ? error.message : "Unknown error";
      }
    }

    await this.db
      .update(integrationWebhookDeliveries)
      .set({
        status: success ? "success" : "failed",
        responseCode,
        lastError,
        attempts: sql`${integrationWebhookDeliveries.attempts} + 1`,
        ...(success ? { deliveredAt: new Date() } : {}),
      })
      .where(
        and(
          eq(integrationWebhookDeliveries.orgId, orgId),
          eq(integrationWebhookDeliveries.id, deliveryId),
        ),
      );

    return { success, responseCode };
  }
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
