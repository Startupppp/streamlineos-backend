import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notifications, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { BroadcastsService } from "./broadcasts.service";
import { ACTOR_COLUMNS, NOTIF_COLUMNS } from "./unified-inbox-projections";
import type { BroadcastInboxItem, NotificationInboxItem } from "./dto/unified-inbox.schemas";

/**
 * The two in-house inbox sources — a member's own notifications and the
 * organization broadcasts addressed to them — read and mapped into the unified
 * item shape.
 *
 * They are the sources whose row shape and index strategy belong to the
 * notifications module itself; `UnifiedInboxService` owns the merge, the cursor
 * arithmetic and the per-source authorization, and the mail and build-approval
 * sources live behind their own modules. Keeping the mapping here means a column
 * added to `notifications` touches one file.
 */

/**
 * Also keyed on `membership_id` — see `countNotificationUnread` for the numbers.
 * `idx_notifications_list_cursor` is `(org_id, membership_id, id DESC)
 * WHERE deleted_at IS NULL AND archived_at IS NULL`, which is this query exactly;
 * on `user_id` it cost 2,043 blocks to return 20 rows and grew with the tenant.
 */
export async function fetchNotificationItems(
  db: Db,
  orgId: string,
  membershipId: number | null,
  fetchLimit: number,
  cursor: number | null,
  unreadOnly: boolean,
): Promise<NotificationInboxItem[]> {
  if (membershipId === null) return [];
  const rows = await db
    .select({ ...NOTIF_COLUMNS, ...ACTOR_COLUMNS })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.membershipId, membershipId),
        isNull(notifications.deletedAt),
        isNull(notifications.archivedAt),
        cursor !== null ? lt(notifications.id, cursor) : undefined,
        unreadOnly ? eq(notifications.isRead, false) : undefined,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(fetchLimit);

  return rows.map(
    (row): NotificationInboxItem => ({
      kind: "notification",
      id: Number(row.id),
      notifType: row.type,
      priority: row.priority,
      category: row.category,
      sourceModule: row.sourceModule ?? "system",
      eventKey: row.eventKey ?? null,
      subject: row.title,
      body: row.message,
      deepLink: row.link ?? null,
      isRead: row.isRead,
      pinned: row.pinned,
      timestamp: row.createdAt.toISOString(),
      dedupKey: `notification:${String(row.id)}`,
      actor: row.actorId
        ? {
            id: row.actorId,
            name: row.actorName ?? null,
            image: row.actorImage ?? null,
          }
        : null,
    }),
  );
}

export async function fetchBroadcastItems(
  broadcasts: BroadcastsService,
  orgId: string,
  userId: string,
  fetchLimit: number,
  cursor: number | null,
  membershipId?: number | null,
): Promise<BroadcastInboxItem[]> {
  const rows = await broadcasts.listInboxPage(
    orgId,
    userId,
    fetchLimit,
    cursor,
    membershipId,
  );

  return rows.map(
    (row): BroadcastInboxItem => ({
      kind: "broadcast",
      id: row.id,
      notifType: row.type,
      priority: row.priority,
      category: row.category,
      sourceModule: "notification",
      subject: row.title,
      body: row.message,
      deepLink: null,
      isRead: false,
      dedupKey: `broadcast:${String(row.id)}`,
      timestamp: (row.sentAt ?? row.createdAt).toISOString(),
      actor: null,
    }),
  );
}
