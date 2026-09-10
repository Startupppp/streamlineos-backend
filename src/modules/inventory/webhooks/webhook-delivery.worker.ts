import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invWebhookEvents, invWebhooks } from "../../../db/schema";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WebhookTransportService } from "./webhook-transport.service";
import {
  WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
  WEBHOOK_RETRY_WINDOW_MS,
  planWebhookAttempt,
  planWebhookHealth,
  type WebhookAttemptPlan,
} from "./webhook-delivery-policy";
import {
  claim,
  type ClaimedDelivery,
  type WebhookDeliverySweepResult,
} from "./lib/webhook-claim";

export type { WebhookDeliverySweepResult };



/**
 * E7 — the retry/dead-letter half of durable outbound webhooks.
 *
 * ## Why this is a worker and not a `void` call in the emitter
 *
 * backend/CLAUDE.md §4: a side effect fired after the request must not borrow the
 * request's transaction. `TenantContextInterceptor` holds one transaction per
 * request in AsyncLocalStorage and `createTenantAwareDb` proxies every service's
 * `this.db` onto it, so a retry scheduled with `void deliverLater()` would run
 * after that transaction had committed, on a handle whose tenant GUC is gone, and
 * die `42501` — silently, because the caller has long since returned. Retries
 * therefore live where there is no request at all: a cron-triggered sweep that
 * opens its own tenant transaction per organisation.
 *
 * ## The shape of one tick
 *
 * Claim → deliver → record, and the middle step is deliberately outside any
 * transaction. Delivering inside the claim transaction is what the old inline
 * emitter did, and it meant a dead endpoint pinned a pooled Postgres connection —
 * tenant GUC set, `idle_in_transaction` ticking — for the full HTTP timeout, per
 * subscriber. Here the transaction ends at the claim and a second one opens only
 * once there is an outcome to write.
 *
 * The claim stamps `leaseExpiresAt`, and every write back is conditional on that
 * exact lease still being on the row (`fenced` in the result). Two workers racing
 * — a slow tick overlapping the next one — cannot both record an outcome for the
 * same attempt, and a worker that dies mid-flight releases its events when the
 * lease expires rather than stranding them.
 */
@Injectable()
export class InventoryWebhookDeliveryWorker {
  private readonly logger = new Logger(InventoryWebhookDeliveryWorker.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly transport: WebhookTransportService,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
    private readonly audit: InventoryAuditService,
  ) {}

  async run(): Promise<WebhookDeliverySweepResult> {
    const result: WebhookDeliverySweepResult = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      alerted: 0,
      disabled: 0,
      fenced: 0,
      orphaned: 0,
    };

    const claimed = await claim(this.db, result);
    result.claimed = claimed.length;

    for (const item of claimed) {
      const outcome = await this.attempt(item);
      if (outcome.fenced) result.fenced += 1;
      else if (outcome.state === "DELIVERED") result.delivered += 1;
      else if (outcome.state === "PENDING") result.retried += 1;
      else result.dead += 1;
      if (outcome.alerted) result.alerted += 1;
      if (outcome.disabled) result.disabled += 1;
    }

    return result;
  }


  private async attempt(item: ClaimedDelivery): Promise<{
    state: "DELIVERED" | "PENDING" | "FAILED";
    fenced: boolean;
    alerted: boolean;
    disabled: boolean;
  }> {
    if (item.webhook === null) {
      const { applied } = await this.record(item, {
        ok: false,
        terminal: true,
        error: "webhook-deleted",
      });
      return { state: "FAILED", fenced: !applied, alerted: false, disabled: false };
    }

    if (!item.webhook.isActive) {
      // Already switched off — by an admin or by this policy. Terminating rather
      // than retrying is what keeps a disabled subscription from quietly
      // accumulating a backlog that fires the moment somebody re-enables it.
      const { applied } = await this.record(item, {
        ok: false,
        terminal: true,
        error: "webhook-inactive",
      });
      return { state: "FAILED", fenced: !applied, alerted: false, disabled: false };
    }

    const outcome = await this.transport.deliver(
      { id: item.webhook.id, url: item.webhook.url, secret: item.webhook.secret },
      {
        id: item.event.id,
        eventType: item.event.eventType,
        payload: item.event.payload,
        createdAt: item.event.createdAt,
        attempt: item.event.attempts + 1,
      },
      { requireHttps: process.env.NODE_ENV === "production" },
    );

    if (outcome.ok) {
      const { applied } = await this.record(item, { ok: true });
      return { state: "DELIVERED", fenced: !applied, alerted: false, disabled: false };
    }

    const { applied, plan } = await this.record(item, { ok: false, error: outcome.error });
    if (!applied) {
      return { state: "FAILED", fenced: true, alerted: false, disabled: false };
    }

    if (plan.deadLetteredAt === null) {
      return { state: "PENDING", fenced: false, alerted: false, disabled: false };
    }

    const health = await this.applyFailurePolicy(item, outcome.error);
    return { state: "FAILED", fenced: false, ...health };
  }

  /**
   * Writes the outcome of one attempt, and hands back the plan it wrote so the
   * caller never recomputes it — two copies of "did this dead-letter?" is one
   * copy that drifts.
   *
   * `applied` is false when the lease no longer matches, which means another
   * worker took the event over and this result is stale: recording it anyway
   * would double-count an attempt and could dead-letter an event the other
   * worker has since delivered.
   */
  private async record(
    item: ClaimedDelivery,
    outcome: { ok: boolean; error?: string; terminal?: boolean },
  ): Promise<{ applied: boolean; plan: WebhookAttemptPlan }> {
    const now = new Date();
    const plan = planWebhookAttempt({
      attempts: item.event.attempts,
      ok: outcome.ok,
      now,
      terminal: outcome.terminal,
    });

    const applied = await runInNewTenantTransaction(this.db, item.orgId, async (tx) => {
      const updated = await tx
        .update(invWebhookEvents)
        .set({
          status: plan.status,
          attempts: plan.attempts,
          nextAttemptAt: plan.nextAttemptAt,
          deliveredAt: plan.deliveredAt,
          deadLetteredAt: plan.deadLetteredAt,
          lastAttemptAt: now,
          lastError: outcome.ok ? null : (outcome.error ?? "unknown"),
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(invWebhookEvents.orgId, item.orgId),
            eq(invWebhookEvents.id, item.event.id),
            eq(invWebhookEvents.leaseExpiresAt, item.lease),
          ),
        )
        .returning({ id: invWebhookEvents.id });

      if (updated.length === 0) return false;
      if (item.webhook === null) return true;

      if (outcome.ok) {
        // A single success clears the streak: the endpoint is demonstrably back,
        // and leaving `alertedAt` set would suppress the alert for the next outage.
        await tx
          .update(invWebhooks)
          .set({
            lastDeliveryAt: now,
            lastDeliveryStatus: "DELIVERED",
            consecutiveFailures: 0,
            failingSince: null,
            alertedAt: null,
          })
          .where(and(eq(invWebhooks.orgId, item.orgId), eq(invWebhooks.id, item.webhook.id)));
        return true;
      }

      await tx
        .update(invWebhooks)
        .set({
          lastDeliveryAt: now,
          lastDeliveryStatus: "FAILED",
          ...(plan.deadLetteredAt !== null && {
            consecutiveFailures: sql`${invWebhooks.consecutiveFailures} + 1`,
            failingSince: sql`coalesce(${invWebhooks.failingSince}, ${now.toISOString()}::timestamp)`,
          }),
        })
        .where(and(eq(invWebhooks.orgId, item.orgId), eq(invWebhooks.id, item.webhook.id)));

      return true;
    });

    return { applied, plan };
  }

  /**
   * Alert, then — only ever later, never in the same call — disable.
   *
   * The two are separate awaits on purpose. `WEBHOOK_ALERT_AFTER_DEAD_LETTERS` is
   * strictly below `WEBHOOK_DISABLE_AFTER_DEAD_LETTERS`, so the alert has already
   * been stamped on an earlier dead letter by the time a disable is reachable;
   * the sequencing here is the belt to that braces, and makes the guarantee hold
   * even if someone later tunes the two thresholds to meet.
   */
  private async applyFailurePolicy(
    item: ClaimedDelivery,
    error: string,
  ): Promise<{ alerted: boolean; disabled: boolean }> {
    const webhook = item.webhook;
    if (webhook === null) return { alerted: false, disabled: false };

    const health = await runInNewTenantTransaction(this.db, item.orgId, async (tx) => {
      const rows = await tx
        .select({
          consecutiveFailures: invWebhooks.consecutiveFailures,
          alertedAt: invWebhooks.alertedAt,
          isActive: invWebhooks.isActive,
          url: invWebhooks.url,
        })
        .from(invWebhooks)
        .where(and(eq(invWebhooks.orgId, item.orgId), eq(invWebhooks.id, webhook.id)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { ...planWebhookHealth(row), url: row.url };
    });

    if (!health) return { alerted: false, disabled: false };

    let alerted = false;
    if (health.alert) {
      alerted = await this.alert(item.orgId, webhook.id, health.url, health.consecutiveFailures, error);
    }

    let disabled = false;
    if (health.disable) {
      disabled = await this.disable(
        item.orgId,
        webhook.id,
        health.url,
        health.consecutiveFailures,
        error,
      );
    }

    return { alerted, disabled };
  }

  /**
   * The alert goes to whoever can actually fix it — the holders of
   * `inventory:webhooks:manage`, the same key that gates the screen where the URL
   * is edited — rather than to org admins by position. An org with nobody holding
   * it still gets the audit row, so the event is never lost to an empty audience.
   */
  private async alert(
    orgId: string,
    webhookId: number,
    url: string,
    consecutiveFailures: number,
    error: string,
  ): Promise<boolean> {
    const hours = Math.round(WEBHOOK_RETRY_WINDOW_MS / 3_600_000);
    const remaining = WEBHOOK_DISABLE_AFTER_DEAD_LETTERS - consecutiveFailures;

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await this.audit.insert(tx, {
        orgId,
        action: "webhook.delivery.alerted",
        resourceType: "webhook",
        resourceId: String(webhookId),
        after: { url, consecutiveFailures, lastError: error },
        metadata: { disableAfter: WEBHOOK_DISABLE_AFTER_DEAD_LETTERS, remaining },
      });
      await tx
        .update(invWebhooks)
        .set({ alertedAt: new Date() })
        .where(and(eq(invWebhooks.orgId, orgId), eq(invWebhooks.id, webhookId)));
    });

    const members = await this.access.membersWithPermission(orgId, "inventory:webhooks:manage");
    if (members.length === 0) {
      this.logger.warn(
        `inventory webhook ${webhookId} for org ${orgId} is failing and nobody holds ` +
          "inventory:webhooks:manage — alert recorded to the audit log only",
      );
      return true;
    }

    await this.dispatch.emit({
      orgId,
      eventKey: "inventory.webhook.failing",
      targetUserIds: members.map((member) => member.userId),
      entityType: "inv_webhook",
      entityId: String(webhookId),
      // One alert per streak: the stamp on `alertedAt` already gates re-alerting,
      // and this makes a concurrent second worker's emission a no-op too.
      dedupeKey: `inv-webhook-failing:${webhookId}:${consecutiveFailures}`,
      title: "Inventory webhook is failing",
      message:
        `${url} has not accepted a delivery in ${hours}h (${consecutiveFailures} dropped). ` +
        `It will be disabled automatically after ${WEBHOOK_DISABLE_AFTER_DEAD_LETTERS}.`,
      link: "/inventory/settings/webhooks",
    });

    return true;
  }

  private async disable(
    orgId: string,
    webhookId: number,
    url: string,
    consecutiveFailures: number,
    error: string,
  ): Promise<boolean> {
    const reason = `auto-disabled after ${consecutiveFailures} undeliverable events`;

    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const updated = await tx
        .update(invWebhooks)
        .set({ isActive: false, disabledAt: new Date(), disabledReason: reason })
        .where(
          and(
            eq(invWebhooks.orgId, orgId),
            eq(invWebhooks.id, webhookId),
            eq(invWebhooks.isActive, true),
          ),
        )
        .returning({ id: invWebhooks.id });

      if (updated.length === 0) return false;

      await this.audit.insert(tx, {
        orgId,
        action: "webhook.auto_disabled",
        resourceType: "webhook",
        resourceId: String(webhookId),
        before: { url, isActive: true },
        after: { url, isActive: false, disabledReason: reason },
        metadata: { consecutiveFailures, lastError: error },
      });

      this.logger.error(
        `inventory webhook ${webhookId} for org ${orgId} auto-disabled: ${reason} (${error})`,
      );
      return true;
    });
  }
}
