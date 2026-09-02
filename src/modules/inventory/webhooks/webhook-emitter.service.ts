import { Injectable, Inject } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { eq, and, sql } from "drizzle-orm";
import { invWebhooks, invWebhookEvents, invWebhookEventSubscriptions } from "../../../db/schema";
import { createHmac } from "crypto";
import type { WebhookEventType } from "./dto/webhooks.schemas";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";

@Injectable()
export class InventoryWebhookEmitter {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async emit(orgId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      const matching = await this.db
        .select({ id: invWebhooks.id, url: invWebhooks.url, secret: invWebhooks.secret })
        .from(invWebhookEventSubscriptions)
        .innerJoin(
          invWebhooks,
          and(
            eq(invWebhooks.id, invWebhookEventSubscriptions.webhookId),
            eq(invWebhooks.orgId, invWebhookEventSubscriptions.orgId),
          ),
        )
        .where(
          and(
            eq(invWebhookEventSubscriptions.orgId, orgId),
            eq(invWebhookEventSubscriptions.eventType, eventType),
            eq(invWebhooks.isActive, true),
          ),
        );
      if (matching.length === 0) return;

      for (const webhook of matching) {
        try {
          const [event] = await this.db
            .insert(invWebhookEvents)
            .values({
              orgId,
              webhookId: webhook.id,
              eventType,
              payload,
              status: "PENDING",
              attempts: 0,
            })
            .returning();

          if (!event) continue;

          const isProd = process.env.NODE_ENV === "production";
          let safeToFetch = true;
          const ssrfResult = await checkWebhookUrl(webhook.url);
          if (!ssrfResult.allowed) {
            logger.warn("webhook-emitter: SSRF guard blocked delivery", {
              orgId,
              webhookId: webhook.id,
              eventType,
              eventId: event.id,
              cause: ssrfResult.reason,
            });
            safeToFetch = false;
          } else if (isProd) {
            let httpsOk = false;
            try {
              httpsOk = new URL(webhook.url).protocol === "https:";
            } catch {
              httpsOk = false;
            }
            if (!httpsOk) {
              logger.warn("webhook-emitter: SSRF guard blocked delivery", {
                orgId,
                webhookId: webhook.id,
                eventType,
                eventId: event.id,
                cause: "https-required-in-production",
              });
              safeToFetch = false;
            }
          }

          const payloadStr = JSON.stringify({
            id: event.id,
            type: eventType,
            data: payload,
            timestamp: event.createdAt,
          });
          const sig = createHmac("sha256", webhook.secret).update(payloadStr).digest("hex");

          let status: "DELIVERED" | "FAILED" = "FAILED";
          if (safeToFetch) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
              const res = await fetch(webhook.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Inventory-Signature": `sha256=${sig}`,
                },
                body: payloadStr,
                signal: controller.signal,
                redirect: "manual",
              });
              clearTimeout(timeout);
              if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
                status = "FAILED";
              } else {
                status = res.ok ? "DELIVERED" : "FAILED";
              }
            } catch (fetchErr) {
              clearTimeout(timeout);
              status = "FAILED";
              logger.warn("webhook-emitter: delivery fetch failed", {
                orgId,
                webhookId: webhook.id,
                eventType,
                eventId: event.id,
                cause: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
              });
            }
          }

          await this.db
            .update(invWebhookEvents)
            .set({
              status,
              attempts: sql`${invWebhookEvents.attempts} + 1`,
              ...(status === "DELIVERED" && { deliveredAt: new Date() }),
            })
            .where(eq(invWebhookEvents.id, event.id));

          await this.db
            .update(invWebhooks)
            .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
            .where(eq(invWebhooks.id, webhook.id));
        } catch (webhookErr) {
          logger.error("webhook-emitter: unhandled per-webhook error", {
            orgId,
            webhookId: webhook.id,
            eventType,
            cause: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
          });
        }
      }
    } catch (dispatchErr) {
      logger.error("webhook-emitter: dispatch loop failed", {
        orgId,
        eventType,
        cause: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      });
    }
  }
}
