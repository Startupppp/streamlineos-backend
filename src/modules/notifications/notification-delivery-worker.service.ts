import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "crypto";
import { and, eq, lte, lt, or, desc, inArray } from "drizzle-orm";
import { notificationDeliveries, notificationQueue, notificationProviderAccounts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import { isTransientDbError } from "../../common/db/transient-error";
import { forEachOrg, withTenant, runWithTenantContext } from "../../common/tenant";

const BATCH_SIZE = 50;
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
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
type Preflight = { delivery: DeliveryRow; sandbox: boolean; attempt: number; provider: Provider };

@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private transientStreak = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationProviderRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.NOTIFICATIONS_INPROCESS_WORKER === "false") return;
    const intervalMs = Number(process.env.NOTIFICATIONS_WORKER_INTERVAL_MS) || 15_000;
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

    await forEachOrg(this.db, "notification-delivery-claim", async (tx, orgId) => {
      const remaining = BATCH_SIZE - claimed.length;
      if (remaining <= 0) return;

      const candidates = await tx
        .select({ id: notificationQueue.id })
        .from(notificationQueue)
        .where(
          and(
            eq(notificationQueue.orgId, orgId),
            or(
              and(eq(notificationQueue.status, "PENDING"), lte(notificationQueue.runAt, now)),
              and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
            ),
          ),
        )
        .orderBy(notificationQueue.runAt)
        .limit(remaining);

      if (candidates.length === 0) return;

      const rows = await tx
        .update(notificationQueue)
        .set({ status: "LOCKED", lockedBy: this.workerId, lockedAt: new Date() })
        .where(
          and(
            eq(notificationQueue.orgId, orgId),
            inArray(notificationQueue.id, candidates.map((c) => c.id)),
            or(
              eq(notificationQueue.status, "PENDING"),
              and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
            ),
          ),
        )
        .returning({ id: notificationQueue.id, deliveryId: notificationQueue.deliveryId });

      for (const row of rows) {
        claimed.push({ id: row.id, deliveryId: row.deliveryId, orgId });
      }
    });

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
                runAt: new Date(Date.now() + BACKOFF_MINUTES[0] * 60_000),
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

      const provider = this.registry.get(delivery.channel);
      if (!provider) {
        await this.markDead(job.id, delivery.id, "NO_PROVIDER", `No provider for ${delivery.channel}`);
        result.dead += 1;
        return null;
      }

      const sandboxRows = await this.db
        .select({ sandboxMode: notificationProviderAccounts.sandboxMode })
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
      const attempt = delivery.attemptCount + 1;

      await this.db
        .update(notificationDeliveries)
        .set({ status: "SENDING", attemptCount: attempt })
        .where(eq(notificationDeliveries.id, delivery.id));

      return { delivery, sandbox, attempt, provider };
    });

    if (!preflight) return;

    const { delivery, sandbox, attempt, provider } = preflight;

    const meta = (delivery.metadata as { title?: string; message?: string; link?: string | null } | null) ?? {};
    const sendResult = await provider.send({
      orgId: delivery.orgId,
      userId: delivery.userId,
      channel: delivery.channel,
      recipientAddress: delivery.recipientAddress,
      title: meta.title ?? "Notification",
      message: meta.message ?? "",
      link: meta.link ?? null,
      priority: delivery.priority,
      sandbox,
    });

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
        const backoff = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)] ?? 60;
        const nextAttemptAt = new Date(now.getTime() + backoff * 60_000);
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
