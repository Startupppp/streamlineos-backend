import { Logger } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { notificationDeliveries, notificationQueue, notificationProviderAccounts, organizationMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import { checkProviderCaps, type ProviderCaps } from "./notification-provider-caps";
import type { ClaimedJob, Preflight, QueueRunResult } from "./notification-delivery-types";


/**
 * Everything `deliverJob` must settle BEFORE it calls a provider: does the delivery still
 * exist, has it expired, is the recipient still an active member, is there a provider for
 * its channel, is the org in sandbox, and what are the provider's caps. It returns the
 * five values the send path needs, or `null` when the job is already resolved and there is
 * nothing to send.
 *
 * Split out of notification-delivery-worker.service.ts when that file crossed the 500-line
 * review limit (CLAUDE.md section 7). The seam is real rather than arithmetic: this half runs
 * inside the tenant transaction and only reads and settles rows, while the half left behind
 * makes the outbound call and interprets its result. It takes its collaborators as arguments
 * for the same reason — it needs a db handle, the provider registry and the dead-letter
 * writer, and nothing else off the worker.
 */
export async function resolveDeliveryPreflight(
  deps: {
    db: Db;
    registry: NotificationProviderRegistry;
    markDead: (queueId: number, deliveryId: number, code: string, message: string) => Promise<void>;
    logger: Logger;
  },
  job: ClaimedJob,
  /** Counters the caller is accumulating; a job settled here still has to be counted. */
  result: QueueRunResult,
): Promise<Preflight | null> {
  const { db, registry, markDead, logger } = deps;
  void logger;
  const delivery = await db.query.notificationDeliveries.findFirst({
    where: and(
      eq(notificationDeliveries.id, job.deliveryId),
      eq(notificationDeliveries.orgId, job.orgId),
    ),
  });

  if (!delivery) {
    await db
      .update(notificationQueue)
      .set({ status: "DONE", lastError: "delivery missing" })
      .where(eq(notificationQueue.id, job.id));
    return null;
  }

  // PIPE-012: a stale notification is worse than none — on recovery from a
  // backlog it arrives as a flood of things that stopped mattering hours ago.
  // CANCELLED, not DEAD: nothing failed, it simply expired.
  if (delivery.expiresAt && delivery.expiresAt.getTime() <= Date.now()) {
    await db
      .update(notificationDeliveries)
      .set({ status: "CANCELLED", failureCode: "EXPIRED", updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, delivery.id));
    await db
      .update(notificationQueue)
      .set({ status: "DONE", lastError: "delivery expired before it was sent" })
      .where(eq(notificationQueue.id, job.id));
    return null;
  }

  // PIPE-015: a delivery can sit in the queue across a deactivation, a suspension
  // or a removal — and under queue lag that window widens exactly when the system
  // is busiest. Membership was checked at enqueue; re-check it here, immediately
  // before handing the payload to a provider. CANCELLED, not DEAD: nothing failed,
  // the recipient simply stopped being entitled to it.
  //
  // Dual-read: when delivery.membershipId is set (post-backfill rows), check that
  // specific membership row directly — a user removed and re-invited gets a new
  // membershipId, so the old delivery references a membership that is now INACTIVE.
  // Legacy rows (membershipId IS NULL) fall back to the userId predicate so
  // nothing is lost while the backfill settles.
  let recipientStillActive: boolean;
  if (typeof delivery.membershipId === "number") {
    const memberRow = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, job.orgId),
          eq(organizationMembers.id, delivery.membershipId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    recipientStillActive = memberRow.length === 1;
  } else {
    const active = await filterOrgMemberIds(db, job.orgId, [delivery.userId]);
    recipientStillActive = active.length > 0;
  }
  if (!recipientStillActive) {
    await db
      .update(notificationDeliveries)
      .set({ status: "CANCELLED", failureCode: "MEMBERSHIP_INACTIVE", updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, delivery.id));
    await db
      .update(notificationQueue)
      .set({ status: "DONE", lastError: "recipient is no longer an active member" })
      .where(eq(notificationQueue.id, job.id));
    return null;
  }

  const provider = registry.get(delivery.channel);
  if (!provider) {
    await markDead(job.id, delivery.id, "NO_PROVIDER", `No provider for ${delivery.channel}`);
    result.dead += 1;
    return null;
  }

  const sandboxRows = await db
    .select({
      sandboxMode: notificationProviderAccounts.sandboxMode,
      // Read here rather than in a second query: this row is already being
      // fetched, and until now nothing anywhere read either column.
      dailySendLimit: notificationProviderAccounts.dailySendLimit,
      monthlyCostLimit: notificationProviderAccounts.monthlyCostLimit,
    })
    .from(notificationProviderAccounts)
    .where(
      and(
        eq(notificationProviderAccounts.orgId, job.orgId),
        eq(notificationProviderAccounts.channel, delivery.channel),
        eq(notificationProviderAccounts.enabled, true),
      ),
    )
    .limit(1);
  const sandbox = sandboxRows[0]?.sandboxMode ?? process.env.NODE_ENV !== "production";
  const caps: ProviderCaps = {
    dailySendLimit: sandboxRows[0]?.dailySendLimit ?? null,
    monthlyCostLimit: sandboxRows[0]?.monthlyCostLimit ?? null,
  };
  const attempt = delivery.attemptCount + 1;

  await db
    .update(notificationDeliveries)
    .set({ status: "SENDING", attemptCount: attempt })
    .where(eq(notificationDeliveries.id, delivery.id));

  return { delivery, sandbox, caps, attempt, provider };
}
