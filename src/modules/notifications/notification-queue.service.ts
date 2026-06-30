import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, lt, isNull, gte } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { QueueListInput } from "./dto/queue.schemas";

@Injectable()
export class NotificationQueueService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getQueue(orgId: string, filters: QueueListInput) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const conditions = [
      eq(notifications.orgId, orgId),
      isNull(notifications.deletedAt),
      gte(notifications.createdAt, since),
    ];
    if (filters.cursor) {
      conditions.push(lt(notifications.id, filters.cursor));
    }
    const rows = await this.db.query.notifications.findMany({
      where: and(...conditions),
      orderBy: [desc(notifications.createdAt)],
      limit: filters.limit,
    });
    return {
      items: rows,
      nextCursor: rows.length === filters.limit ? rows[rows.length - 1]?.id : null,
    };
  }

  async getFailed(orgId: string, filters: QueueListInput) {
    const conditions = [
      eq(notifications.orgId, orgId),
      eq(notifications.type, "ERROR"),
      isNull(notifications.deletedAt),
    ];
    if (filters.cursor) {
      conditions.push(lt(notifications.id, filters.cursor));
    }
    const rows = await this.db.query.notifications.findMany({
      where: and(...conditions),
      orderBy: [desc(notifications.createdAt)],
      limit: filters.limit,
    });
    return {
      items: rows,
      nextCursor: rows.length === filters.limit ? rows[rows.length - 1]?.id : null,
    };
  }

  async retry(orgId: string, notificationId: number) {
    const existing = await this.db.query.notifications.findFirst({
      where: and(
        eq(notifications.id, notificationId),
        eq(notifications.orgId, orgId),
        isNull(notifications.deletedAt),
      ),
    });
    if (!existing) throw new NotFoundException("Notification not found");
    return { success: true, message: "Retry queued" };
  }
}
