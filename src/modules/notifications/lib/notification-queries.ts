import {
  eq,
  and,
  desc,
  sql,
  isNull,
  isNotNull,
  inArray,
  lt,
  lte,
  gt,
  ilike,
  or,
} from "drizzle-orm";
import {
  notifications,
  notificationReadWatermarks,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { ListInput } from "../dto/notification.schemas";
import { ASSIGNED_EVENT_KEYS, MENTION_EVENT_KEYS } from "../inbox-section-keys";
import { attachTicketContext } from "./notification-ticket-context";

/**
 * The inbox queries, and the row shape they return.
 *
 * Split from the service because the service is now only a cache: `list` and
 * `unreadCount` wrap these two in `cached`, and everything that decides WHAT is
 * in an inbox — the section filters, the read watermark, the ticket context
 * joined onto matching rows — is here. The watermark is why the two halves
 * cannot be collapsed: `fetchLastReadId` is read by both the list and the
 * count, and a count computed from a different watermark than the list would
 * show a badge for rows the list does not have.
 *
 * Plain `db` parameters rather than a deps bag: the cache stays on the service,
 * which is the layer that knows the key.
 */

export type NotificationListRow = {
  id: number;
  orgId: string;
  userId: string | null;
  type: string;
  priority: string;
  category: string;
  sourceModule: string | null;
  eventKey: string | null;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  pinned: boolean;
  channel: string;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | null;
  snoozedUntil: Date | null;
  createdAt: Date;
};

const LIST_COLUMNS = {
  id: notifications.id,
  orgId: notifications.orgId,
  userId: notifications.userId,
  type: notifications.type,
  priority: notifications.priority,
  category: notifications.category,
  sourceModule: notifications.sourceModule,
  eventKey: notifications.eventKey,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
  reason: notifications.reason,
  title: notifications.title,
  message: notifications.message,
  link: notifications.link,
  isRead: notifications.isRead,
  pinned: notifications.pinned,
  channel: notifications.channel,
  metadata: notifications.metadata,
  archivedAt: notifications.archivedAt,
  snoozedUntil: notifications.snoozedUntil,
  createdAt: notifications.createdAt,
} as const;

async function fetchLastReadId(db: Db, orgId: string, userId: string): Promise<number> {
  const [wm] = await db
    .select({ lastReadId: notificationReadWatermarks.lastReadNotificationId })
    .from(notificationReadWatermarks)
    .where(
      and(
        eq(notificationReadWatermarks.orgId, orgId),
        eq(notificationReadWatermarks.userId, userId),
      ),
    );
  return wm?.lastReadId ?? 0;
}

export async function queryNotifications(
  db: Db,
  orgId: string,
  userId: string,
  filters: ListInput & { section: string },
) {
  const lastReadId = await fetchLastReadId(db, orgId, userId);

  const conditions = [
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    isNull(notifications.deletedAt),
  ];

  switch (filters.section) {
    case "UNREAD":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(eq(notifications.isRead, false));
      if (lastReadId > 0) conditions.push(gt(notifications.id, lastReadId));
      break;
    case "READ":
      conditions.push(isNull(notifications.archivedAt));
      if (lastReadId > 0) {
        const readByFlagOrWatermark = or(
          eq(notifications.isRead, true),
          lte(notifications.id, lastReadId),
        );
        if (readByFlagOrWatermark) conditions.push(readByFlagOrWatermark);
      } else {
        conditions.push(eq(notifications.isRead, true));
      }
      break;
    case "ARCHIVED":
      conditions.push(isNotNull(notifications.archivedAt));
      break;
    case "SYSTEM":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(eq(notifications.category, "SYSTEM"));
      break;
    case "PINNED":
      conditions.push(eq(notifications.pinned, true));
      break;
    case "MENTIONS":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(inArray(notifications.eventKey, MENTION_EVENT_KEYS));
      break;
    case "ASSIGNED_TO_ME":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(inArray(notifications.eventKey, ASSIGNED_EVENT_KEYS));
      break;
    case "APPROVALS":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(eq(notifications.category, "WORKFLOW"));
      break;
    case "BROADCASTS":
      conditions.push(isNull(notifications.archivedAt));
      conditions.push(eq(notifications.sourceModule, "broadcast"));
      break;
    default:
      conditions.push(isNull(notifications.archivedAt));
      break;
  }

  if (
    filters.category &&
    filters.section !== "SYSTEM" &&
    filters.section !== "APPROVALS"
  ) {
    conditions.push(eq(notifications.category, filters.category));
  }
  if (filters.priority) {
    conditions.push(eq(notifications.priority, filters.priority));
  }
  if (filters.sourceModule) {
    conditions.push(eq(notifications.sourceModule, filters.sourceModule));
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(
      ilike(notifications.title, term),
      ilike(notifications.message, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  if (filters.cursor) {
    conditions.push(lt(notifications.id, filters.cursor));
  }

  const rows = await db
    .select(LIST_COLUMNS)
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.id))
    .limit(filters.limit);

  return attachTicketContext(db, 
    orgId,
    rows.map((row) => ({
      ...row,
      isRead: row.isRead || (lastReadId > 0 && row.id <= lastReadId),
    })),
  );
}

export async function queryUnreadCount(db: Db, orgId: string, userId: string) {
  const lastReadId = await fetchLastReadId(db, orgId, userId);
  const conditions = [
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    eq(notifications.isRead, false),
    isNull(notifications.deletedAt),
    isNull(notifications.archivedAt),
  ];
  if (lastReadId > 0) conditions.push(gt(notifications.id, lastReadId));
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(...conditions));
  return { count: Number(result?.count ?? 0) };
}
