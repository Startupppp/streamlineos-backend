import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { randomUUID } from "crypto";
import { and, eq, lte, lt, or, desc, inArray, sql } from "drizzle-orm";
import { notificationDeliveries, notificationQueue, notificationProviderAccounts, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { isTransientDbError } from "../../common/db/transient-error";
import { forEachOrg, withTenant, runWithTenantContext } from "../../common/tenant";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";
import { NotificationCircuitBreaker } from "./notification-circuit-breaker";
import {
  DeliveryClass,
  backoffMinutesForAttempt,
  resolveDeliveryClassForEvent,
} from "./notification-delivery-class";
import { providerSendResultSchema, type ProviderSendResultParsed } from "./dto/provider-result.schemas";
import { checkProviderCaps, type ProviderCaps } from "./notification-provider-caps";

const BATCH_SIZE = 50;
export const ORG_BATCH_CAP = Math.ceil(BATCH_SIZE / 5);

/**
 * PIPE-010. Backoff was exact, so every delivery that failed against the same
 * provider outage retried in the same instant — the herd re-forms on each step and
 * hits the provider (and its rate limit) all at once. Full jitter spreads a step
 * uniformly across its own window, which is the standard fix and costs nothing.
 */
function backoffMsWithJitter(minutes: number): number {
  const windowMs = minutes * 60_000;
  return Math.floor(windowMs / 2 + Math.random() * (windowMs / 2));
}
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface QueueRunResult {
  processed: number;
  sent: number;
  failed: number;
  dead: number;
}

type ClaimedJob = { id: number; deliveryId: number; orgId: string };
type DeliveryRow = typeof notificationDeliveries.$inferSelect;
type Provider = NonNullable<ReturnType<NotificationProviderRegistry["get"]>>;
type Preflight = { delivery: DeliveryRow; sandbox: boolean; caps: ProviderCaps; attempt: number; provider: Provider };

@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private transientStreak = 0;
  private readonly breaker = new NotificationCircuitBreaker();
  /**
   * Where the previous tick's budget ran out, so the next one starts after it.
   * In-process rather than persisted: a lost cursor costs one unfair tick, and
   * every claim is fenced by `for update skip locked` and its lock timestamp.
   */
  private cursorOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationProviderRegistry,
    private readonly events: NotificationEventRegistryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.NOTIFICATIONS_INPROCESS_WORKER === "false") return;
    const intervalMs = this.config.NOTIFICATIONS_WORKER_INTERVAL_MS ?? 15_000;
    this.drainTimer = setInterval(() => {
      void this.drainTick();
    }, intervalMs);
    this.drainTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private async drainTick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.processQueue();
      if (this.transientStreak > 0) {
        this.logger.log(
          `Notification delivery worker recovered after ${this.transientStreak} transient DB connection failure(s)`,
        );
        this.transientStreak = 0;
      }
    } catch (error) {
      if (isTransientDbError(error)) {
        this.transientStreak += 1;
        if (this.transientStreak === 1) {
          this.logger.warn(
            "Notification delivery worker: transient DB connection issue (retrying each tick; suppressing repeats until recovery)",
          );
        }
      } else {
        this.logger.error(
          `in-process delivery drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.draining = false;
    }
  }

  async processQueue(): Promise<QueueRunResult> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const result: QueueRunResult = { processed: 0, sent: 0, failed: 0, dead: 0 };

    const claimed: ClaimedJob[] = [];
    let lastClaimedFromOrgId: string | null = null;

    await forEachOrg(
      this.db,
      "notification-delivery-claim",
      async (tx, orgId) => {
        const remaining = BATCH_SIZE - claimed.length;
        if (remaining <= 0) return;
        const orgLimit = Math.min(remaining, ORG_BATCH_CAP);

        // SCH-016: one statement with FOR UPDATE SKIP LOCKED, replacing a SELECT-ids
        // then UPDATE-where-in pair. The old shape was *correct* — the status re-check
        // in the UPDATE meant only one worker won — but two workers burned a round trip
        // fighting over the same rows, and neither could make progress past a row the
        // other held. SKIP LOCKED lets each take a disjoint set on the first try.
        //
        // The timestamps are passed as ISO strings with an explicit cast. A JS Date bound
        // into a drizzle sql template reaches postgres.js where a string is expected and
        // the statement dies with ERR_INVALID_ARG_TYPE — which failed this claim for EVERY
        // organization, invisibly: forEachOrg logs and continues, and drizzle's message is
        // only "Failed query", with the real reason on the error's cause.
        const rows = await tx
          .update(notificationQueue)
          .set({ status: "LOCKED", lockedBy: this.workerId, lockedAt: new Date() })
          .where(
            sql`${notificationQueue.id} in (
            select id from ${notificationQueue}
            where org_id = ${orgId}
              and (
                (status = 'PENDING' and run_at <= ${now.toISOString()}::timestamptz)
                or (status = 'LOCKED' and locked_at < ${staleBefore.toISOString()}::timestamptz)
              )
            order by run_at
            limit ${orgLimit}
            for update skip locked
          )`,
          )
          .returning({ id: notificationQueue.id, deliveryId: notificationQueue.deliveryId });

        if (rows.length === 0) return;
        for (const row of rows.slice(0, orgLimit)) {
          claimed.push({ id: row.id, deliveryId: row.deliveryId, orgId });
        }
        lastClaimedFromOrgId = orgId;
      },
      "write",
      {
        /**
         * ORG_BATCH_CAP alone bounds what one tenant may take, but `forEachOrg`
         * enumerates ascending by org id with no rotation, so floor(50/10) = 5
         * organizations are served every tick and they are always the SAME five.
         * Measured over 8 tenants x 200 queued jobs x 5 ticks: orgs 01-05 each
         * drained 50, orgs 06-08 drained nothing, in any tick. Starvation caused by
         * where an org id sorts, not by tenant skew. The cursor makes the tenants a
         * full tick could not reach the ones the next tick starts from.
         */
        startAfterOrgId: this.cursorOrgId,
        stopWhen: () => claimed.length >= BATCH_SIZE,
      },
    );

    // Only a tick that ran out of budget leaves a cursor: one that drained every
    // tenant has no one to be fair to, and starting from the top keeps it deterministic.
    this.cursorOrgId = claimed.length >= BATCH_SIZE ? lastClaimedFromOrgId : null;

    if (claimed.length === 0) return result;

    for (const job of claimed) {
      result.processed += 1;
      try {
        await this.deliverJob(job, now, result);
      } catch (error) {
        this.logger.error(`Queue job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
        try {
          await this.inTenant(job.orgId, () =>
            this.db
              .update(notificationQueue)
              .set({
                status: "PENDING",
                runAt: new Date(
                  Date.now() + backoffMsWithJitter(backoffMinutesForAttempt(DeliveryClass.PRODUCT_EVENT, 1)),
                ),
                lastError: "worker exception",
              })
              .where(eq(notificationQueue.id, job.id)),
          );
        } catch (resetErr) {
          this.logger.error(
            `Queue job ${job.id} could not be reset to PENDING: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`,
          );
        }
        result.failed += 1;
      }
    }

    return result;
  }

  private inTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, fn),
    );
  }

  private async deliverJob(job: ClaimedJob, now: Date, result: QueueRunResult): Promise<void> {
    const preflight = await this.inTenant(job.orgId, async (): Promise<Preflight | null> => {
      const delivery = await this.db.query.notificationDeliveries.findFirst({
        where: and(
          eq(notificationDeliveries.id, job.deliveryId),
          eq(notificationDeliveries.orgId, job.orgId),
        ),
      });

      if (!delivery) {
        await this.db
          .update(notificationQueue)
          .set({ status: "DONE", lastError: "delivery missing" })
          .where(eq(notificationQueue.id, job.id));
        return null;
      }

      // PIPE-012: a stale notification is worse than none — on recovery from a
      // backlog it arrives as a flood of things that stopped mattering hours ago.
      // CANCELLED, not DEAD: nothing failed, it simply expired.
      if (delivery.expiresAt && delivery.expiresAt.getTime() <= Date.now()) {
        await this.db
          .update(notificationDeliveries)
          .set({ status: "CANCELLED", failureCode: "EXPIRED", updatedAt: new Date() })
          .where(eq(notificationDeliveries.id, delivery.id));
        await this.db
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
        const memberRow = await this.db
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
        const active = await filterOrgMemberIds(this.db, job.orgId, [delivery.userId]);
        recipientStillActive = active.length > 0;
      }
      if (!recipientStillActive) {
        await this.db
          .update(notificationDeliveries)
          .set({ status: "CANCELLED", failureCode: "MEMBERSHIP_INACTIVE", updatedAt: new Date() })
          .where(eq(notificationDeliveries.id, delivery.id));
        await this.db
          .update(notificationQueue)
          .set({ status: "DONE", lastError: "recipient is no longer an active member" })
          .where(eq(notificationQueue.id, job.id));
        return null;
      }

      const provider = this.registry.get(delivery.channel);
      if (!provider) {
        await this.markDead(job.id, delivery.id, "NO_PROVIDER", `No provider for ${delivery.channel}`);
        result.dead += 1;
        return null;
      }

      const sandboxRows = await this.db
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

      await this.db
        .update(notificationDeliveries)
        .set({ status: "SENDING", attemptCount: attempt })
        .where(eq(notificationDeliveries.id, delivery.id));

      return { delivery, sandbox, caps, attempt, provider };
    });

    if (!preflight) return;

    const { delivery, sandbox, caps, attempt, provider } = preflight;

    const meta = (delivery.metadata as {
      title?: string;
      message?: string;
      link?: string | null;
      emailHtml?: string;
      attachments?: Array<{ filename: string; contentBase64: string; type: string }>;
    } | null) ?? {};
    // COMP-002: resolved from the catalog rather than stored on the delivery row, so
    // it always reflects the event's current mandatory flag. An unknown key is treated
    // as mandatory — the conservative direction, since the cost of wrongly omitting an
    // unsubscribe header is far lower than wrongly advertising one.
    const definition = delivery.eventKey
      ? this.events.getBaseDefinition(delivery.eventKey)
      : undefined;

    // PIPE-010: if this provider has been failing consecutively, requeue without
    // calling it. Skipped, not failed — the attempt counter is untouched, so a provider
    // outage cannot push deliveries to DEAD while the breaker is holding them back.
    // The operator's own spend controls, enforced the same way and for the same
    // reason: a cap is a throttle, so the delivery is requeued at the window
    // boundary with `attemptCount` untouched rather than failed. Skipped in sandbox,
    // where nothing is spent and nothing is sent.
    if (!sandbox) {
      const verdict = await checkProviderCaps(this.db, delivery.orgId, delivery.channel, caps, now);
      if (!verdict.allowed) {
        this.logger.warn(
          `Provider cap reached in org ${delivery.orgId}: ${verdict.reason}; delivery ${delivery.id} requeued`,
        );
        await this.inTenant(job.orgId, () =>
          this.db
            .update(notificationQueue)
            .set({
              status: "PENDING",
              runAt: new Date(now.getTime() + verdict.retryAfterMs),
              lockedBy: null,
              lockedAt: null,
              lastError: verdict.reason,
            })
            .where(eq(notificationQueue.id, job.id)),
        );
        return;
      }
    }

    const breaker = this.breaker.check(delivery.orgId, delivery.channel, now.getTime());
    if (breaker.open) {
      await this.inTenant(job.orgId, () =>
        this.db
          .update(notificationQueue)
          .set({
            status: "PENDING",
            runAt: new Date(now.getTime() + breaker.retryAfterMs),
            lockedBy: null,
            lockedAt: null,
            lastError: `circuit open for ${delivery.channel}`,
          })
          .where(eq(notificationQueue.id, job.id)),
      );
      return;
    }

    const rawSendResult = await provider.send({
      orgId: delivery.orgId,
      userId: delivery.userId,
      mandatory: definition?.mandatory ?? true,
      channel: delivery.channel,
      recipientAddress: delivery.recipientAddress,
      title: meta.title ?? "Notification",
      message: meta.message ?? "",
      link: meta.link ?? null,
      priority: delivery.priority,
      sandbox,
      metadata: delivery.metadata ?? undefined,
    });
    const sendOutcome = providerSendResultSchema.safeParse(rawSendResult);
    if (!sendOutcome.success)
      this.logger.warn(
        `Provider ${delivery.channel} in org ${delivery.orgId} returned an invalid response shape; treating as retryable failure`,
      );
    const fallback: ProviderSendResultParsed = {
      status: "FAILED",
      retryable: true,
      failureCode: "INVALID_RESPONSE",
      failureMessage: "Provider returned an invalid response shape",
    };
    const sendResult = sendOutcome.success ? sendOutcome.data : fallback;

    if (sendResult.status === "SENT") this.breaker.recordSuccess(delivery.orgId, delivery.channel);
    else if (this.breaker.recordFailure(delivery.orgId, delivery.channel, now.getTime())) {
      this.logger.warn(
        `Circuit opened for ${delivery.channel} in org ${delivery.orgId} after repeated provider failures; ` +
          "deliveries will be requeued without contacting the provider until it closes",
      );
    }

    await this.inTenant(job.orgId, async () => {
      if (sendResult.status === "SENT") {
        await this.db
          .update(notificationDeliveries)
          .set({
            status: "SENT",
            sentAt: now,
            provider: delivery.provider,
            providerMessageId: sendResult.providerMessageId ?? null,
            providerResponse: sendResult.providerResponse ?? null,
            costAmount: sendResult.costAmount ?? delivery.costAmount,
            costCurrency: sendResult.costCurrency ?? delivery.costCurrency,
            failureCode: null,
            failureMessage: null,
          })
          .where(eq(notificationDeliveries.id, delivery.id));
        await this.db
          .update(notificationQueue)
          .set({ status: "DONE", attemptCount: attempt, lastError: null })
          .where(eq(notificationQueue.id, job.id));
        result.sent += 1;
        return;
      }

      const retryable = sendResult.retryable ?? false;
      if (retryable && attempt < delivery.maxAttempts) {
        const backoff = backoffMinutesForAttempt(
          resolveDeliveryClassForEvent(delivery.eventKey ?? undefined),
          attempt,
        );
        const nextAttemptAt = new Date(now.getTime() + backoffMsWithJitter(backoff));
        await this.db
          .update(notificationDeliveries)
          .set({
            status: "FAILED",
            failedAt: now,
            failureCode: sendResult.failureCode ?? null,
            failureMessage: sendResult.failureMessage ?? null,
            nextAttemptAt,
          })
          .where(eq(notificationDeliveries.id, delivery.id));
        await this.db
          .update(notificationQueue)
          .set({
            status: "PENDING",
            runAt: nextAttemptAt,
            attemptCount: attempt,
            lastError: sendResult.failureMessage ?? null,
          })
          .where(eq(notificationQueue.id, job.id));
        result.failed += 1;
        return;
      }

      await this.markDead(
        job.id,
        delivery.id,
        sendResult.failureCode ?? "FAILED",
        sendResult.failureMessage ?? "Delivery failed",
        attempt,
      );
      result.dead += 1;
    });
  }

  private async markDead(
    jobId: number,
    deliveryId: number,
    code: string,
    message: string,
    attempt?: number,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(notificationDeliveries)
      .set({ status: "DEAD", failedAt: now, failureCode: code, failureMessage: message })
      .where(eq(notificationDeliveries.id, deliveryId));
    await this.db
      .update(notificationQueue)
      .set({ status: "DEAD", lastError: message, ...(attempt !== undefined ? { attemptCount: attempt } : {}) })
      .where(eq(notificationQueue.id, jobId));
  }

  /** Admin-triggered retry: re-arm a FAILED/DEAD delivery and its queue job. */
  async retryDelivery(orgId: string, deliveryId: number): Promise<boolean> {
    const delivery = await this.db.query.notificationDeliveries.findFirst({
      where: and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.orgId, orgId)),
    });
    if (!delivery) return false;
    const now = new Date();
    await this.db
      .update(notificationDeliveries)
      .set({ status: "QUEUED", nextAttemptAt: now, failureCode: null, failureMessage: null })
      .where(eq(notificationDeliveries.id, deliveryId));
    const existingJob = await this.db.query.notificationQueue.findFirst({
      where: eq(notificationQueue.deliveryId, deliveryId),
      orderBy: [desc(notificationQueue.id)],
    });
    
    if (existingJob) 
      await this.db
        .update(notificationQueue)
        .set({ status: "PENDING", runAt: now, lockedBy: null, lockedAt: null, lastError: null })
        .where(eq(notificationQueue.id, existingJob.id));
     else 
      await this.db
        .insert(notificationQueue)
        .values({ deliveryId, orgId, channel: delivery.channel, runAt: now, status: "PENDING" });
    
    return true;
  }
}
