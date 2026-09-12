import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invWebhookEvents, invWebhooks } from "../../../../db/schema";
import { forEachOrg } from "../../../../common/tenant";
import type { TenantTx } from "../../../../common/tenant/with-tenant";
import {
  WEBHOOK_DELIVERY_BATCH_SIZE,
  WEBHOOK_DELIVERY_LEASE_MS,
} from "../webhook-delivery-policy";

export interface WebhookDeliverySweepResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  alerted: number;
  disabled: number;
  fenced: number;
  orphaned: number;
}

export interface ClaimedDelivery {
  readonly orgId: string;
  readonly lease: Date;
  readonly event: {
    readonly id: number;
    readonly eventType: string;
    readonly payload: unknown;
    readonly attempts: number;
    readonly createdAt: Date;
  };
  readonly webhook:
    | { readonly id: number; readonly url: string; readonly secret: string; readonly isActive: boolean }
    | null;
}

/**
 * Taking webhook deliveries off the queue, and retiring the ones that can never
 * be delivered — lifted out of `webhook-delivery.worker.ts` unchanged.
 *
 * Both were private with no caller outside the worker. `claim` used only the db
 * handle and `terminateOrphans`, which used nothing; the handle is a parameter
 * now. The worker keeps the sweep loop and the attempt/record/failure path.
 */
  /**
   * One tenant transaction per organisation. `forEachOrg` is the only way a
   * background sweep can read `inv_webhook_events` at all: the table is under RLS
   * and the sweep has no ambient GUC, so a cross-org discovery query is denied
   * `42501`. It also isolates failures — one tenant's claim rolling back leaves
   * the rest of the sweep running.
   */
export async function claim(
    db: Db,
    result: WebhookDeliverySweepResult,
  ): Promise<ClaimedDelivery[]> {
    const now = new Date();
    const lease = new Date(now.getTime() + WEBHOOK_DELIVERY_LEASE_MS);
    const claimed: ClaimedDelivery[] = [];

    await forEachOrg(db, "inventory-webhook-delivery", async (tx, orgId) => {
      result.orphaned += await terminateOrphans(tx, orgId, now);

      const remaining = WEBHOOK_DELIVERY_BATCH_SIZE - claimed.length;
      if (remaining <= 0) return;

      const nowIso = now.toISOString();
      const rows = await tx
        .update(invWebhookEvents)
        .set({ leaseExpiresAt: lease })
        .where(
          sql`${invWebhookEvents.id} in (
            select id from ${invWebhookEvents}
            where org_id = ${orgId}
              and status = 'PENDING'
              and dead_lettered_at is null
              and webhook_id is not null
              and next_attempt_at is not null
              and next_attempt_at <= ${nowIso}::timestamp
              and (lease_expires_at is null or lease_expires_at <= ${nowIso}::timestamp)
            order by next_attempt_at
            limit ${remaining}
            for update skip locked
          )`,
        )
        .returning({
          id: invWebhookEvents.id,
          webhookId: invWebhookEvents.webhookId,
          eventType: invWebhookEvents.eventType,
          payload: invWebhookEvents.payload,
          attempts: invWebhookEvents.attempts,
          createdAt: invWebhookEvents.createdAt,
        });

      if (rows.length === 0) return;

      const webhookIds = Array.from(
        new Set(rows.map((row) => row.webhookId).filter((id): id is number => id !== null)),
      );
      const webhooks =
        webhookIds.length === 0
          ? []
          : await tx
              .select({
                id: invWebhooks.id,
                url: invWebhooks.url,
                secret: invWebhooks.secret,
                isActive: invWebhooks.isActive,
              })
              .from(invWebhooks)
              .where(and(eq(invWebhooks.orgId, orgId), inArray(invWebhooks.id, webhookIds)));
      const byId = new Map(webhooks.map((webhook) => [webhook.id, webhook]));

      for (const row of rows) {
        claimed.push({
          orgId,
          lease,
          event: {
            id: row.id,
            eventType: row.eventType,
            payload: row.payload,
            attempts: row.attempts,
            createdAt: row.createdAt,
          },
          webhook: row.webhookId === null ? null : (byId.get(row.webhookId) ?? null),
        });
      }
    });

    return claimed;
  }

  /**
   * `inv_webhook_events.webhook_id` is `ON DELETE SET NULL`, so deleting a webhook
   * leaves its queued events pointing at nothing. They can never be delivered and
   * the claim above skips them, which without this would leave a permanently
   * PENDING row per event for the life of the table — indistinguishable, to
   * anyone reading the events list, from work that is still going to happen.
   */
export async function terminateOrphans(tx: TenantTx, orgId: string, now: Date): Promise<number> {
    const rows = await tx
      .update(invWebhookEvents)
      .set({
        status: "FAILED",
        deadLetteredAt: now,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError: "webhook-deleted",
      })
      .where(
        and(
          eq(invWebhookEvents.orgId, orgId),
          eq(invWebhookEvents.status, "PENDING"),
          sql`${invWebhookEvents.webhookId} is null`,
          sql`${invWebhookEvents.deadLetteredAt} is null`,
        ),
      )
      .returning({ id: invWebhookEvents.id });
    return rows.length;
  }
