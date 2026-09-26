import { and, eq, gt, type SQL } from "drizzle-orm";
import { notifications, notificationReadWatermarks } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

export function notificationUnread(lastReadId: number): SQL | undefined {
  if (lastReadId > 0)
    return and(eq(notifications.isRead, false), gt(notifications.id, lastReadId));
  return eq(notifications.isRead, false);
}

export function readByWatermark(id: number, lastReadId: number): boolean {
  return lastReadId > 0 && id <= lastReadId;
}

export async function readNotificationWatermark(
  db: Db,
  orgId: string,
  membershipId: number,
): Promise<number> {
  const rows = await db
    .select({ lastReadId: notificationReadWatermarks.lastReadNotificationId })
    .from(notificationReadWatermarks)
    .where(
      and(
        eq(notificationReadWatermarks.orgId, orgId),
        eq(notificationReadWatermarks.membershipId, membershipId),
      ),
    );
  return Number(rows[0]?.lastReadId ?? 0);
}
