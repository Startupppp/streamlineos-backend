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
  gte,
  ilike,
  or,
} from "drizzle-orm";
import {
  notifications,
  notificationReadWatermarks,
  organizationMembers,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { ListInput } from "../dto/notification.schemas";
import { ASSIGNED_EVENT_KEYS, MENTION_EVENT_KEYS } from "../inbox-section-keys";
import { notificationWindowEnd, notificationWindowStart } from "../notification-read-window";

/**
 * The inbox queries, and the row shape they return.
 *
 * Split from the service because the service is now only a cache: `list` and
 * `unreadCount` wrap these two in `cached`, and everything that decides WHAT is
 * in an inbox — the recipient's membership, the retention window, the section
 * filters and the read watermark — is here. The watermark is why the two
 * halves cannot be collapsed: `resolveRecipient` is read by both the list and
 * the count, and a count computed from a different watermark than the list
 * would show a badge for rows the list does not have.
 *
 * The ticket context a row may carry is attached by the service after the
 * cache (`notification-ticket-context.ts`), because it depends on who is
 * reading and a cached page is shared by every read of the same filters.
 *
 * Plain `db` parameters rather than a deps bag: the cache stays on the service,
 * which is the layer that knows the key.
 */

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

/**
 * The tenant authority and the read watermark are one row apart, so they are one
 * statement: resolving them separately cost three round trips per read, because
 * the watermark lookup re-resolved the membership it was already given.
 */
async function resolveRecipient(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ membershipId: number; lastReadId: number }> {
  const [recipient] = await db
    .select({
      membershipId: organizationMembers.id,
      lastReadId: notificationReadWatermarks.lastReadNotificationId,
    })
    .from(organizationMembers)
    .leftJoin(
      notificationReadWatermarks,
      and(
        eq(notificationReadWatermarks.orgId, organizationMembers.orgId),
        eq(notificationReadWatermarks.membershipId, organizationMembers.id),
      ),
    )
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!recipient) throw new Error("Organization membership required");
  return { membershipId: recipient.membershipId, lastReadId: recipient.lastReadId ?? 0 };
}

function retentionWindow(): { start: Date; end: Date } {
  const now = new Date();
  return { start: notificationWindowStart(now), end: notificationWindowEnd(now) };
}

export async function queryNotifications(
  db: Db,
  orgId: string,
  userId: string,
  filters: ListInput & { section: string },
) {
  const { membershipId, lastReadId } = await resolveRecipient(db, orgId, userId);
  const window = retentionWindow();

  const conditions = [
    eq(notifications.orgId, orgId),
    eq(notifications.membershipId, membershipId),
    gte(notifications.createdAt, window.start),
    lt(notifications.createdAt, window.end),
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
    // One row past the page: its presence is what `hasMore` is read from, which is
    // cheaper here than a second COUNT over an unbounded notification table.
    .limit(filters.limit + 1);

  const page = buildIdCursorPage(rows, filters.limit, (row) => row.id);
  const data = page.data.map((row) => ({
    ...row,
    isRead: row.isRead || (lastReadId > 0 && row.id <= lastReadId),
  }));

  return { data, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

export async function queryUnreadCount(db: Db, orgId: string, userId: string) {
  const { membershipId, lastReadId } = await resolveRecipient(db, orgId, userId);
  const window = retentionWindow();
  const conditions = [
    eq(notifications.orgId, orgId),
    eq(notifications.membershipId, membershipId),
    gte(notifications.createdAt, window.start),
    lt(notifications.createdAt, window.end),
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
