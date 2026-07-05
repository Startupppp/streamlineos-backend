import { Injectable, Inject } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { eq, and } from "drizzle-orm";
import { invWebhooks, invWebhookEvents } from "../../db/schema";
import { createHmac } from "crypto";
import type { WebhookEventType } from "./dto/webhooks.schemas";

@Injectable()
export class InventoryWebhookEmitter {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async emit(orgId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      const webhooks = await this.db
        .select()
        .from(invWebhooks)
        .where(and(eq(invWebhooks.orgId, orgId), eq(invWebhooks.isActive, true)));

      const matching = webhooks.filter((w) => (w.events as string[]).includes(eventType));
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

          const payloadStr = JSON.stringify({
            id: event.id,
            type: eventType,
            data: payload,
            timestamp: event.createdAt,
          });
          const sig = createHmac("sha256", webhook.secret).update(payloadStr).digest("hex");
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          let status: "DELIVERED" | "FAILED" = "FAILED";
          try {
            const res = await fetch(webhook.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Inventory-Signature": `sha256=${sig}`,
              },
              body: payloadStr,
              signal: controller.signal,
            });
            clearTimeout(timeout);
            status = res.ok ? "DELIVERED" : "FAILED";
          } catch {
            clearTimeout(timeout);
            status = "FAILED";
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
        } catch {
        }
      }
    } catch {
    }
  }
}
