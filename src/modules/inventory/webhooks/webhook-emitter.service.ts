import { Injectable, Inject, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { eq, and } from "drizzle-orm";
import { invWebhooks, invWebhookEvents, invWebhookEventSubscriptions } from "../../../db/schema";
import type { WebhookEventType } from "./dto/webhooks.schemas";

export interface WebhookEmitOptions {
  /**
   * Stable id of whatever produced this event — the outbox `eventId` from
   * `InventoryOutboxConsumer`. Replaying that producer then enqueues nothing
   * instead of a second customer-visible webhook.
   */
  readonly dedupeKey?: string;
}

/**
 * E7 — enqueue, do not deliver.
 *
 * ## What this used to do, and why every part of it was wrong
 *
 * `emit` opened with a subscription lookup and then, per matching webhook,
 * inserted a row, resolved DNS, ran one `fetch`, and wrote the result — all
 * inline. Three consequences:
 *
 *  1. **One attempt was the whole policy.** A receiver that was restarting lost
 *     the event permanently; the row said FAILED and nothing ever looked at it
 *     again unless a human found it and pressed retry.
 *  2. **HTTP ran inside a tenant transaction.** `OutboxPublisher` invokes the
 *     consumer inside `runInNewTenantTransaction`, so a 10s timeout against a
 *     dead endpoint held a pooled Postgres connection, with its tenant GUC set,
 *     for those 10 seconds — multiplied by every subscriber.
 *  3. **Every failure was swallowed.** Two nested `try/catch`es logged and
 *     returned, so the publisher saw success and marked the outbox event
 *     DELIVERED whatever happened — including a failure to insert the event row
 *     at all, which is backend/CLAUDE.md §4's "never swallow a deferred failure"
 *     in its most literal form: the record that the webhook was owed never
 *     existed and nothing said so.
 *
 * Now `emit` does exactly one thing — durably record what is owed to whom — and
 * `InventoryWebhookDeliveryWorker` does the delivering, outside any transaction,
 * on the schedule in `webhook-delivery-policy.ts`. Nothing is caught here: an
 * insert that fails must reach `OutboxPublisher`, which is what retries and
 * ultimately dead-letters the *producing* event rather than losing it.
 */
@Injectable()
export class InventoryWebhookEmitter {
  private readonly logger = new Logger(InventoryWebhookEmitter.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async emit(
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
    options: WebhookEmitOptions = {},
  ): Promise<{ enqueued: number }> {
    const matching = await this.db
      .select({ id: invWebhooks.id })
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

    if (matching.length === 0) return { enqueued: 0 };

    const now = new Date();
    const inserted = await this.db
      .insert(invWebhookEvents)
      .values(
        matching.map((webhook) => ({
          orgId,
          webhookId: webhook.id,
          eventType,
          payload,
          status: "PENDING" as const,
          attempts: 0,
          // Due immediately: the worker's next tick is the first attempt.
          nextAttemptAt: now,
          dedupeKey: options.dedupeKey ?? null,
        })),
      )
      // Only bites when a dedupeKey is present — the unique index is partial on
      // `dedupe_key is not null`, so callers without one still get a row each.
      .onConflictDoNothing({
        target: [invWebhookEvents.orgId, invWebhookEvents.webhookId, invWebhookEvents.dedupeKey],
      })
      .returning({ id: invWebhookEvents.id });

    if (inserted.length < matching.length) {
      this.logger.debug(
        `${eventType} for org ${orgId}: ${matching.length - inserted.length} of ${matching.length} ` +
          `subscriber deliveries already enqueued for dedupe key ${options.dedupeKey ?? "<none>"}`,
      );
    }

    return { enqueued: inserted.length };
  }
}
