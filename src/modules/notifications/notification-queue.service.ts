import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, lt, inArray, sql } from "drizzle-orm";
import { notificationDeliveries, notificationQueue } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { QueueListInput } from "./dto/queue.schemas";
import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";
import type { NotificationChannel } from "./notification.types";

const ACTIVE_STATUSES = ["PENDING", "QUEUED", "SENDING"] as const;
const FAILED_STATUSES = ["FAILED", "DEAD", "BOUNCED"] as const;

@Injectable()
export class NotificationQueueService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly worker: NotificationDeliveryWorker,
  ) {}

  private baseColumns() {
    return {
      id: notificationDeliveries.id,
      notificationId: notificationDeliveries.notificationId,
      eventKey: notificationDeliveries.eventKey,
      userId: notificationDeliveries.userId,
      channel: notificationDeliveries.channel,
      provider: notificationDeliveries.provider,
      recipientAddress: notificationDeliveries.recipientAddress,
      status: notificationDeliveries.status,
      priority: notificationDeliveries.priority,
      attemptCount: notificationDeliveries.attemptCount,
      maxAttempts: notificationDeliveries.maxAttempts,
      nextAttemptAt: notificationDeliveries.nextAttemptAt,
      sentAt: notificationDeliveries.sentAt,
      failedAt: notificationDeliveries.failedAt,
      failureCode: notificationDeliveries.failureCode,
      failureMessage: notificationDeliveries.failureMessage,
      suppressionReason: notificationDeliveries.suppressionReason,
      costAmount: notificationDeliveries.costAmount,
      costCurrency: notificationDeliveries.costCurrency,
      createdAt: notificationDeliveries.createdAt,
    };
  }

  private async listByStatuses(orgId: string, statuses: readonly string[], filters: QueueListInput) {
    const conditions = [
      eq(notificationDeliveries.orgId, orgId),
      inArray(notificationDeliveries.status, filters.status ? [filters.status] : [...statuses]),
    ];
    if (filters.channel) conditions.push(eq(notificationDeliveries.channel, filters.channel as NotificationChannel));
    if (filters.eventKey) conditions.push(eq(notificationDeliveries.eventKey, filters.eventKey));
    if (filters.cursor) conditions.push(lt(notificationDeliveries.id, filters.cursor));

    const rows = await this.db
      .select(this.baseColumns())
      .from(notificationDeliveries)
      .where(and(...conditions))
      .orderBy(desc(notificationDeliveries.id))
      .limit(filters.limit);

    return { items: rows, nextCursor: rows.length === filters.limit ? rows[rows.length - 1]?.id ?? null : null };
  }

  getQueue(orgId: string, filters: QueueListInput) {
    return this.listByStatuses(orgId, ACTIVE_STATUSES, filters);
  }

  getFailed(orgId: string, filters: QueueListInput) {
    return this.listByStatuses(orgId, FAILED_STATUSES, filters);
  }

  async stats(orgId: string) {
    const rows = await this.db
      .select({ status: notificationDeliveries.status, count: sql<number>`count(*)::int` })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.orgId, orgId))
      .groupBy(notificationDeliveries.status);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = Number(r.count);
    const pending = (byStatus.PENDING ?? 0) + (byStatus.QUEUED ?? 0) + (byStatus.SENDING ?? 0);
    const failed = (byStatus.FAILED ?? 0) + (byStatus.BOUNCED ?? 0);
    return { byStatus, pending, sent: byStatus.SENT ?? 0, delivered: byStatus.DELIVERED ?? 0, failed, dead: byStatus.DEAD ?? 0, suppressed: byStatus.SUPPRESSED ?? 0 };
  }

  async retry(orgId: string, deliveryId: number) {
    const ok = await this.worker.retryDelivery(orgId, deliveryId);
    return { success: ok, message: ok ? "Delivery re-queued" : "Delivery not found" };
  }

  async bulkRetry(orgId: string, ids: number[]) {
    let retried = 0;
    for (const id of ids) {
      if (await this.worker.retryDelivery(orgId, id)) retried += 1;
    }
    return { success: true, retried };
  }

  async cancel(orgId: string, deliveryId: number) {
    const delivery = await this.db.query.notificationDeliveries.findFirst({
      where: and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.orgId, orgId)),
    });
    if (!delivery) return { success: false, message: "Delivery not found" };
    await this.db.update(notificationDeliveries).set({ status: "CANCELLED" }).where(eq(notificationDeliveries.id, deliveryId));
    await this.db.update(notificationQueue).set({ status: "DONE", lastError: "cancelled" }).where(eq(notificationQueue.deliveryId, deliveryId));
    return { success: true, message: "Delivery cancelled" };
  }

  processQueue() {
    return this.worker.processQueue();
  }
}
