import type { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invWebhooks } from "../../../../db/schema";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { AccessService } from "../../../access/access.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import {
  WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
  WEBHOOK_RETRY_WINDOW_MS,
  planWebhookHealth,
} from "../webhook-delivery-policy";
import type { ClaimedDelivery } from "./webhook-claim";

/**
 * E7's subscription-health policy — what happens to a WEBHOOK that keeps
 * failing — lifted out of `webhook-delivery.worker.ts` unchanged.
 *
 * The worker keeps the per-delivery path: claim (already in `webhook-claim.ts`),
 * `attempt`, and `record`, which fence-writes one event's outcome under its
 * lease using nothing but the db handle and the transport. This half starts only
 * after an event has dead-lettered, and it is about the subscription rather than
 * the event: it re-reads the webhook's streak, decides through
 * `planWebhookHealth` whether to alert and whether to disable, and carries out
 * both — notifying the holders of `inventory:webhooks:manage` and switching the
 * subscription off. Its dependencies are the ones the delivery path never
 * touches (`AccessService`, `NotificationDispatchService`, the audit log and the
 * logger), and the delivery path's are ones it never touches (the transport).
 *
 * Only `applyFailurePolicy` is exported. `alert` and `disable` were private to
 * the worker and stay private to this file: `disable` switches a subscription
 * off with no caller permission check because the SWEEP is the authority, and
 * exporting it would make an ungated disable importable from anywhere. The one
 * entry point re-reads the row and acts only on thresholds the policy computes.
 */
export interface WebhookHealthDeps {
  readonly db: Db;
  readonly access: AccessService;
  readonly dispatch: NotificationDispatchService;
  readonly audit: InventoryAuditService;
  /** The worker's own logger, so these lines keep its context name. */
  readonly logger: Logger;
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
export async function applyFailurePolicy(
  deps: WebhookHealthDeps,
  item: ClaimedDelivery,
  error: string,
): Promise<{ alerted: boolean; disabled: boolean }> {
  const webhook = item.webhook;
  if (webhook === null) return { alerted: false, disabled: false };

  const health = await runInNewTenantTransaction(deps.db, item.orgId, async (tx) => {
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
    alerted = await alert(deps, item.orgId, webhook.id, health.url, health.consecutiveFailures, error);
  }

  let disabled = false;
  if (health.disable) {
    disabled = await disable(
      deps,
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
async function alert(
  deps: WebhookHealthDeps,
  orgId: string,
  webhookId: number,
  url: string,
  consecutiveFailures: number,
  error: string,
): Promise<boolean> {
  const hours = Math.round(WEBHOOK_RETRY_WINDOW_MS / 3_600_000);
  const remaining = WEBHOOK_DISABLE_AFTER_DEAD_LETTERS - consecutiveFailures;

  await runInNewTenantTransaction(deps.db, orgId, async (tx) => {
    await deps.audit.insert(tx, {
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

  const members = await deps.access.membersWithPermission(orgId, "inventory:webhooks:manage");
  if (members.length === 0) {
    deps.logger.warn(
      `inventory webhook ${webhookId} for org ${orgId} is failing and nobody holds ` +
        "inventory:webhooks:manage — alert recorded to the audit log only",
    );
    return true;
  }

  await deps.dispatch.emit({
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

async function disable(
  deps: WebhookHealthDeps,
  orgId: string,
  webhookId: number,
  url: string,
  consecutiveFailures: number,
  error: string,
): Promise<boolean> {
  const reason = `auto-disabled after ${consecutiveFailures} undeliverable events`;

  return runInNewTenantTransaction(deps.db, orgId, async (tx) => {
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

    await deps.audit.insert(tx, {
      orgId,
      action: "webhook.auto_disabled",
      resourceType: "webhook",
      resourceId: String(webhookId),
      before: { url, isActive: true },
      after: { url, isActive: false, disabledReason: reason },
      metadata: { consecutiveFailures, lastError: error },
    });

    deps.logger.error(
      `inventory webhook ${webhookId} for org ${orgId} auto-disabled: ${reason} (${error})`,
    );
    return true;
  });
}
