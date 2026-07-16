import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { and, eq, lte, lt, or, desc, inArray } from "drizzle-orm";
import { notificationDeliveries, notificationQueue, notificationProviderAccounts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import type { NotificationChannel } from "./notification.types";

const BATCH_SIZE = 50;
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface QueueRunResult {
  processed: number;
  sent: number;
  failed: number;
  dead: number;
}

@Injectable()
export class NotificationDeliveryWorker {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationProviderRegistry,
  ) {}

  async processQueue(): Promise<QueueRunResult> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const result: QueueRunResult = { processed: 0, sent: 0, failed: 0, dead: 0 };

    const candidates = await this.db
      .select({ id: notificationQueue.id })
      .from(notificationQueue)
      .where(
        or(
          and(eq(notificationQueue.status, "PENDING"), lte(notificationQueue.runAt, now)),
          and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
        ),
      )
      .orderBy(notificationQueue.runAt)
      .limit(BATCH_SIZE);
    if (candidates.length === 0) return result;

    const claimed = await this.db
      .update(notificationQueue)
      .set({ status: "LOCKED", lockedBy: this.workerId, lockedAt: new Date() })
      .where(
        and(
          inArray(notificationQueue.id, candidates.map((c) => c.id)),
          or(
            eq(notificationQueue.status, "PENDING"),
            and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
          ),
        ),
      )
      .returning({ id: notificationQueue.id, deliveryId: notificationQueue.deliveryId });
    if (claimed.length === 0) return result;

    const deliveries = await this.db.query.notificationDeliveries.findMany({
      where: inArray(notificationDeliveries.id, claimed.map((c) => c.deliveryId)),
    });
    const deliveryById = new Map(deliveries.map((d) => [d.id, d]));
    const sandboxByKey = await this.loadSandboxStates(deliveries);

    for (const job of claimed) {
      const delivery = deliveryById.get(job.deliveryId);
      result.processed += 1;
      if (!delivery) {
        await this.db.update(notificationQueue).set({ status: "DONE", lastError: "delivery missing" }).where(eq(notificationQueue.id, job.id));
        continue;
      }
      const sandbox = sandboxByKey.get(`${delivery.orgId}:${delivery.channel}`) ?? process.env.NODE_ENV !== "production";
      try {
        await this.processJob(job.id, delivery, sandbox, result);
      } catch (error) {
        this.logger.error(`Queue job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
        await this.db
          .update(notificationQueue)
          .set({ status: "PENDING", runAt: new Date(Date.now() + BACKOFF_MINUTES[0] * 60_000), lastError: "worker exception" })
          .where(eq(notificationQueue.id, job.id));
        result.failed += 1;
      }
    }
    return result;
  }

  private async loadSandboxStates(
    deliveries: Array<{ orgId: string; channel: NotificationChannel }>,
  ): Promise<Map<string, boolean>> {
    const orgIds = [...new Set(deliveries.map((d) => d.orgId))];
    if (orgIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        orgId: notificationProviderAccounts.orgId,
        channel: notificationProviderAccounts.channel,
        sandboxMode: notificationProviderAccounts.sandboxMode,
      })
      .from(notificationProviderAccounts)
      .where(and(eq(notificationProviderAccounts.enabled, true), inArray(notificationProviderAccounts.orgId, orgIds)));
    return new Map(rows.map((r) => [`${r.orgId}:${r.channel}`, r.sandboxMode]));
  }

  private async processJob(
    jobId: number,
    delivery: typeof notificationDeliveries.$inferSelect,
    sandbox: boolean,
    result: QueueRunResult,
  ): Promise<void> {
    const channel = delivery.channel;
    const provider = this.registry.get(channel);
    if (!provider) {
      await this.markDead(jobId, delivery.id, "NO_PROVIDER", `No provider for ${channel}`);
      result.dead += 1;
      return;
    }

    const attempt = delivery.attemptCount + 1;
    const now = new Date();
    await this.db.update(notificationDeliveries).set({ status: "SENDING", attemptCount: attempt }).where(eq(notificationDeliveries.id, delivery.id));

    const meta = (delivery.metadata as { title?: string; message?: string; link?: string | null } | null) ?? {};
    const sendResult = await provider.send({
      orgId: delivery.orgId,
      userId: delivery.userId,
      channel,
      recipientAddress: delivery.recipientAddress,
      title: meta.title ?? "Notification",
      message: meta.message ?? "",
      link: meta.link ?? null,
      priority: delivery.priority,
      sandbox,
    });

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
      await this.db.update(notificationQueue).set({ status: "DONE", attemptCount: attempt, lastError: null }).where(eq(notificationQueue.id, jobId));
      result.sent += 1;
      return;
    }

    const retryable = sendResult.retryable ?? false;
    if (retryable && attempt < delivery.maxAttempts) {
      const backoff = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)] ?? 60;
      const nextAttemptAt = new Date(now.getTime() + backoff * 60_000);
      await this.db
        .update(notificationDeliveries)
        .set({ status: "FAILED", failedAt: now, failureCode: sendResult.failureCode ?? null, failureMessage: sendResult.failureMessage ?? null, nextAttemptAt })
        .where(eq(notificationDeliveries.id, delivery.id));
      await this.db
        .update(notificationQueue)
        .set({ status: "PENDING", runAt: nextAttemptAt, attemptCount: attempt, lastError: sendResult.failureMessage ?? null })
        .where(eq(notificationQueue.id, jobId));
      result.failed += 1;
      return;
    }

    await this.markDead(jobId, delivery.id, sendResult.failureCode ?? "FAILED", sendResult.failureMessage ?? "Delivery failed", attempt);
    result.dead += 1;
  }

  private async markDead(jobId: number, deliveryId: number, code: string, message: string, attempt?: number): Promise<void> {
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
    if (existingJob) {
      await this.db.update(notificationQueue).set({ status: "PENDING", runAt: now, lockedBy: null, lockedAt: null, lastError: null }).where(eq(notificationQueue.id, existingJob.id));
    } else {
      await this.db.insert(notificationQueue).values({ deliveryId, orgId, channel: delivery.channel, runAt: now, status: "PENDING" });
    }
    return true;
  }
}
