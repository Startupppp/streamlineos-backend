import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { and, eq, lte, lt, or, desc } from "drizzle-orm";
import { notificationDeliveries, notificationQueue, notificationProviderAccounts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import type { NotificationChannel, NotificationPriority } from "./notification.types";

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
    const candidates = await this.db
      .select({ id: notificationQueue.id, deliveryId: notificationQueue.deliveryId, attemptCount: notificationQueue.attemptCount })
      .from(notificationQueue)
      .where(
        or(
          and(eq(notificationQueue.status, "PENDING"), lte(notificationQueue.runAt, now)),
          and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
        ),
      )
      .orderBy(notificationQueue.runAt)
      .limit(BATCH_SIZE);

    const result: QueueRunResult = { processed: 0, sent: 0, failed: 0, dead: 0 };

    for (const candidate of candidates) {
      const [claimed] = await this.db
        .update(notificationQueue)
        .set({ status: "LOCKED", lockedBy: this.workerId, lockedAt: new Date() })
        .where(
          and(
            eq(notificationQueue.id, candidate.id),
            or(
              eq(notificationQueue.status, "PENDING"),
              and(eq(notificationQueue.status, "LOCKED"), lt(notificationQueue.lockedAt, staleBefore)),
            ),
          ),
        )
        .returning({ id: notificationQueue.id, deliveryId: notificationQueue.deliveryId, attemptCount: notificationQueue.attemptCount });
      if (!claimed) continue;

      result.processed += 1;
      try {
        await this.processJob(claimed.id, claimed.deliveryId, result);
      } catch (error) {
        this.logger.error(`Queue job ${claimed.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
        await this.db
          .update(notificationQueue)
          .set({ status: "PENDING", runAt: new Date(Date.now() + BACKOFF_MINUTES[0] * 60_000), lastError: "worker exception" })
          .where(eq(notificationQueue.id, claimed.id));
        result.failed += 1;
      }
    }
    return result;
  }

  private async isSandbox(orgId: string, channel: NotificationChannel): Promise<boolean> {
    const account = await this.db.query.notificationProviderAccounts.findFirst({
      where: and(
        eq(notificationProviderAccounts.orgId, orgId),
        eq(notificationProviderAccounts.channel, channel),
        eq(notificationProviderAccounts.enabled, true),
      ),
    });
    if (account) return account.sandboxMode;
    return process.env.NODE_ENV !== "production";
  }

  private async processJob(jobId: number, deliveryId: number, result: QueueRunResult): Promise<void> {
    const delivery = await this.db.query.notificationDeliveries.findFirst({
      where: eq(notificationDeliveries.id, deliveryId),
    });
    if (!delivery) {
      await this.db.update(notificationQueue).set({ status: "DONE", lastError: "delivery missing" }).where(eq(notificationQueue.id, jobId));
      return;
    }

    const channel = delivery.channel as NotificationChannel;
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
    const sandbox = await this.isSandbox(delivery.orgId, channel);
    const sendResult = await provider.send({
      orgId: delivery.orgId,
      userId: delivery.userId,
      channel,
      recipientAddress: delivery.recipientAddress,
      title: meta.title ?? "Notification",
      message: meta.message ?? "",
      link: meta.link ?? null,
      priority: delivery.priority as NotificationPriority,
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
