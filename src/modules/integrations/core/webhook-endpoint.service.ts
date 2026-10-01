import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  integrationWebhookEndpointCredentials,
  integrationWebhookDeliveries,
} from "../../../db/schema/integrations/webhook-delivery";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  postSafeWebhook,
  UnsafeWebhookTargetError,
} from "../../../common/outbound/safe-webhook-transport";
import { INTEGRATIONS_WEBHOOK_DELIVERY_EVENT, MISSING_SIGNING_SECRET_ERROR } from "./webhook-delivery.service";
import { buildSignedRequest } from "./webhook-signing";

const INTERACTIVE_TIMEOUT_MS = 5_000;
const RESPONSE_BODY_LIMIT = 2000;

export interface DeliveryIntent {
  credentialId: number;
  buildWebhookId: number;
  targetUrl: string;
  event: string;
  payload: Record<string, unknown>;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

@Injectable()
export class WebhookEndpointService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createCredential(
    tx: DbOrTx,
    orgId: string,
    providedSecret?: string,
  ): Promise<{ id: number; secretSetAt: Date }> {
    const signingSecret = providedSecret ?? generateWebhookSecret();
    const secretSetAt = new Date();
    const [credential] = await tx
      .insert(integrationWebhookEndpointCredentials)
      .values({ orgId, signingSecret, secretSetAt })
      .returning({ id: integrationWebhookEndpointCredentials.id });
    if (!credential) throw new Error("Failed to create webhook credential");
    return { id: credential.id, secretSetAt };
  }

  async deleteCredential(tx: DbOrTx, orgId: string, credentialId: number): Promise<void> {
    await tx
      .delete(integrationWebhookEndpointCredentials)
      .where(
        and(
          eq(integrationWebhookEndpointCredentials.orgId, orgId),
          eq(integrationWebhookEndpointCredentials.id, credentialId),
        ),
      );
  }

  async requestDeliveries(tx: DbOrTx, orgId: string, intents: DeliveryIntent[]): Promise<void> {
    if (intents.length === 0) return;
    const now = new Date();
    const deliveries = await tx
      .insert(integrationWebhookDeliveries)
      .values(
        intents.map((i) => ({
          orgId,
          credentialId: i.credentialId,
          buildWebhookId: i.buildWebhookId,
          targetUrl: i.targetUrl,
          event: i.event,
          payload: i.payload,
          status: "pending" as const,
          attempts: 0,
          nextAttemptAt: now,
        })),
      )
      .returning({ id: integrationWebhookDeliveries.id });

    if (deliveries.length !== intents.length)
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

  async listDeliveries(orgId: string, webhookId: number) {
    return this.db
      .select({
        id: integrationWebhookDeliveries.id,
        webhookId: integrationWebhookDeliveries.buildWebhookId,
        event: integrationWebhookDeliveries.event,
        status: integrationWebhookDeliveries.status,
        responseCode: integrationWebhookDeliveries.responseCode,
        attempts: integrationWebhookDeliveries.attempts,
        lastError: integrationWebhookDeliveries.lastError,
        createdAt: integrationWebhookDeliveries.createdAt,
        deliveredAt: integrationWebhookDeliveries.deliveredAt,
      })
      .from(integrationWebhookDeliveries)
      .where(
        and(
          eq(integrationWebhookDeliveries.orgId, orgId),
          eq(integrationWebhookDeliveries.buildWebhookId, webhookId),
        ),
      )
      .orderBy(desc(integrationWebhookDeliveries.createdAt))
      .limit(20);
  }

  async deliveryStats(
    orgId: string,
    webhookIds: number[],
  ): Promise<
    Map<
      number,
      { lastDeliveryAt: Date | null; lastDeliveryStatus: string | null; failureRate: number | null }
    >
  > {
    const statsRows = await this.db.execute<{
      webhookId: number;
      lastDeliveryAt: Date | null;
      lastDeliveryStatus: string | null;
      failureRate: number | null;
    }>(sql`
      WITH ranked AS (
        SELECT
          build_webhook_id,
          created_at,
          status,
          ROW_NUMBER() OVER (PARTITION BY build_webhook_id ORDER BY created_at DESC) AS rn,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) OVER (PARTITION BY build_webhook_id)::float
            / NULLIF(COUNT(*) OVER (PARTITION BY build_webhook_id), 0) AS failure_rate
        FROM integration_webhook_deliveries
        WHERE org_id = ${orgId}
          AND build_webhook_id = ANY(${webhookIds})
      )
      SELECT
        build_webhook_id::int AS "webhookId",
        created_at AS "lastDeliveryAt",
        status AS "lastDeliveryStatus",
        failure_rate AS "failureRate"
      FROM ranked
      WHERE rn = 1
    `);

    const result = new Map<
      number,
      { lastDeliveryAt: Date | null; lastDeliveryStatus: string | null; failureRate: number | null }
    >();
    for (const row of statsRows) {
      result.set(row.webhookId, {
        lastDeliveryAt: row.lastDeliveryAt,
        lastDeliveryStatus: row.lastDeliveryStatus,
        failureRate: row.failureRate,
      });
    }
    return result;
  }

  async sendTestDelivery(
    orgId: string,
    webhookId: number,
    credentialId: number | null,
    url: string,
    testPayload: Record<string, unknown>,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    const signingSecret = credentialId
      ? await this.db
          .select({ signingSecret: integrationWebhookEndpointCredentials.signingSecret })
          .from(integrationWebhookEndpointCredentials)
          .where(
            and(
              eq(integrationWebhookEndpointCredentials.orgId, orgId),
              eq(integrationWebhookEndpointCredentials.id, credentialId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]?.signingSecret ?? null)
      : null;

    const deliveryId = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const now = new Date();
        const [delivery] = await tx
          .insert(integrationWebhookDeliveries)
          .values({
            orgId,
            credentialId,
            buildWebhookId: webhookId,
            targetUrl: url,
            event: "webhook.test",
            payload: testPayload,
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
          })
          .returning({ id: integrationWebhookDeliveries.id });
        if (!delivery) throw new Error("Failed to persist test webhook delivery intent");
        return delivery.id;
      },
      { orgId },
    );

    return this.deliverInteractive(orgId, deliveryId, url, signingSecret, "webhook.test", testPayload);
  }

  private async deliverInteractive(
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

    const { body, headers } = buildSignedRequest(signingSecret, eventName, payload, deliveryId);

    let responseCode: number | null = null;
    let success = false;
    let lastError: string | null = null;

    try {
      const response = await postSafeWebhook(
        url,
        body,
        headers,
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
