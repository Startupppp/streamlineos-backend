import { Injectable, Inject } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { eq, and } from "drizzle-orm";
import { invWebhooks, invWebhookEvents, invWebhookEventSubscriptions } from "../../../db/schema";
import { createHmac } from "crypto";
import type { WebhookEventType } from "./dto/webhooks.schemas";
import { assertSafeWebhookUrl } from "./webhooks.service";

@Injectable()
export class InventoryWebhookEmitter {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async emit(orgId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      // Indexed dispatch. This previously loaded every active webhook for the
      // org and filtered a jsonb array in application memory, which cannot use
      // an index and grows linearly with webhook count.
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

          // Re-validate immediately before the outbound fetch to close the
          // DNS-rebinding / TOCTOU window between registration and delivery.
          const isProd = process.env.NODE_ENV === "production";
          let safeToFetch = true;
          try {
            await assertSafeWebhookUrl(webhook.url, isProd);
          } catch {
            safeToFetch = false;
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
              // Treat any redirect (3xx) as a failed delivery — we do not chase
              // redirects because the redirect target may point at an internal address.
              if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
                status = "FAILED";
              } else {
                status = res.ok ? "DELIVERED" : "FAILED";
              }
            } catch {
              clearTimeout(timeout);
              status = "FAILED";
            }
          }

          await this.db
            .update(invWebhookEvents)
            .set({
              status,
              attempts: event.attempts + 1,
              ...(status === "DELIVERED" && { deliveredAt: new Date() }),
            })
            .where(eq(invWebhookEvents.id, event.id));

          await this.db
            .update(invWebhooks)
            .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
            .where(eq(invWebhooks.id, webhook.id));
        } catch (err) {
          void err;
        }
      }
    } catch (err) {
      void err;
    }
  }
}
