import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq, sql, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { hrWebhookDeliveries, hrWebhookSubscriptions } from "../../../../db/schema/hr/webhooks";
import { callProvider } from "../../../../common/outbound/call-provider";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import {
  WEBHOOK_TIMEOUT_MS,
  webhookDescriptor,
  readSigningSecret,
  logFromResult,
} from "../../../webhooks/lib/webhook-delivery";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "../../../webhooks/dto/webhook.schemas";

@Injectable()
export class HrWebhookDispatchService {
  private readonly logger = new Logger(HrWebhookDispatchService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Sweep pending deliveries and attempt to dispatch them.
   */
  async sweep(): Promise<void> {
    const pending = await this.db
      .select({
        delivery: hrWebhookDeliveries,
        subscription: hrWebhookSubscriptions,
      })
      .from(hrWebhookDeliveries)
      .innerJoin(
        hrWebhookSubscriptions,
        eq(hrWebhookDeliveries.subscriptionId, hrWebhookSubscriptions.id),
      )
      .where(
        and(
          eq(hrWebhookDeliveries.status, "pending"),
          // Basic exponential backoff attempt (could be improved)
          sql`last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '1 minute' * 2^attempts`,
        ),
      )
      .limit(10);

    for (const { delivery, subscription } of pending) {
      await this.dispatch(delivery, subscription);
    }
  }

  private async dispatch(
    delivery: typeof hrWebhookDeliveries.$inferSelect,
    subscription: typeof hrWebhookSubscriptions.$inferSelect,
  ): Promise<void> {
    const body = JSON.stringify({
      event: delivery.event,
      data: delivery.payload,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac("sha256", readSigningSecret(subscription.secret))
      .update(body)
      .digest("hex");

    const result = await callProvider(
      webhookDescriptor(subscription.id),
      async () => {
        const { statusCode, responseBody } = await postSafeWebhook(
          subscription.url,
          body,
          {
            "Content-Type": "application/json",
            "X-StreamlineOS-Signature": `sha256=${signature}`,
            "X-Webhook-Event": delivery.event,
          },
          WEBHOOK_TIMEOUT_MS,
          WEBHOOK_RESPONSE_BODY_LIMIT,
        );
        if (statusCode < 200 || statusCode >= 300) throw new Error(`HTTP ${statusCode}`);
        return { status: statusCode, body: responseBody };
      },
      // Assuming a shared breaker is acceptable, or we need a new one
    );

    const { statusCode, responseBody, success } = logFromResult(result);

    await this.db
      .update(hrWebhookDeliveries)
      .set({
        status: success ? "delivered" : result.attempts >= 5 ? "dead" : "failed",
        attempts: result.attempts,
        lastAttemptAt: new Date(),
        responseStatus: statusCode,
        error: success ? null : responseBody,
      })
      .where(eq(hrWebhookDeliveries.id, delivery.id));

    if (!success) {
      this.logger.warn(`Failed HR webhook delivery ${delivery.id}`, {
        orgId: delivery.orgId,
        subscriptionId: delivery.subscriptionId,
        error: responseBody,
      });
    }
  }
}
