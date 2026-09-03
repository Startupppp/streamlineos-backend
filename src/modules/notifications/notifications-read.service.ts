import { Inject, Injectable } from "@nestjs/common";
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
import { notifications, notificationReadWatermarks, tickets, projects, users, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { listSchema, type ListInput } from "./dto/notification.schemas";
import type { NotificationTicketContext } from "./notifications.types";
import { ASSIGNED_EVENT_KEYS, MENTION_EVENT_KEYS } from "./inbox-section-keys";
import { notificationWindowEnd, notificationWindowStart } from "./notification-read-window";

type NotificationListRow = {
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

function extractTicketId(row: {
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}): number | null {
  if (row.entityType === "ticket" && row.entityId) {
    const fromEntity = Number.parseInt(row.entityId, 10);
    if (Number.isFinite(fromEntity)) return fromEntity;
  }
  const metaId = row.metadata?.ticketId;
  if (typeof metaId === "number" && Number.isFinite(metaId)) return metaId;
  if (typeof metaId === "string") {
    const fromMeta = Number.parseInt(metaId, 10);
    if (Number.isFinite(fromMeta)) return fromMeta;
  }
  return null;
}

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

@Injectable()
export class NotificationsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  /**
   * Derived from `listSchema` itself rather than written out, because the
   * hand-written key omitted `sourceModule` — an accepted, `.strict()`-validated
   * query parameter and a real predicate at `queryNotifications`. So
   * `?sourceModule=hr` and `?sourceModule=chat` hashed to the same key and, within
   * CACHE_TTL.SHORT, the second caller was served the first one's filtered page.
   * Scoped to one user+org, so not a tenant leak — silently wrong data.
   *
   * `check:namespace-coverage` cannot see this class of bug: it verifies that
   * namespaces are bumped, never that the inner key enumerates every filter
   * dimension. Enumerating the schema is what makes the next added filter safe by
   * construction instead of by whoever remembers this comment.
   */
  private listCacheKey(filters: ListInput, section: string, limit: number): string {
    const resolved: Record<string, unknown> = { ...filters, section, limit };
    const parts = Object.keys(listSchema.shape)
      .sort()
      .map((field) => `${field}=${String(resolved[field] ?? "")}`);
    return `list:${parts.join("&")}`;
  }

  list(orgId: string, userId: string, filters: ListInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const section = filters.unreadOnly ? "UNREAD" : (filters.section ?? "ALL");
    const key = this.listCacheKey(filters, section, limit);
    return this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      key,
      () =>
        this.queryNotifications(orgId, userId, { ...filters, limit, section }),
      CACHE_TTL.SHORT,
    );
  }

  /**
   * The tenant authority and the read watermark are one row apart, so they are one
   * statement: resolving them separately cost three round trips per read, because
   * the watermark lookup re-resolved the membership it was already given.
   */
  private async resolveRecipient(
    orgId: string,
    userId: string,
  ): Promise<{ membershipId: number; lastReadId: number }> {
    const [recipient] = await this.db
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

  private retentionWindow(): { start: Date; end: Date } {
    const now = new Date();
    return { start: notificationWindowStart(now), end: notificationWindowEnd(now) };
  }

  private async queryNotifications(
    orgId: string,
    userId: string,
    filters: ListInput & { section: string },
  ) {
    const { membershipId, lastReadId } = await this.resolveRecipient(orgId, userId);
    const window = this.retentionWindow();

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

    const rows = await this.db
      .select(LIST_COLUMNS)
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.id))
      // One row past the page: its presence is what `hasMore` is read from, which is
      // cheaper here than a second COUNT over an unbounded notification table.
      .limit(filters.limit + 1);

    const page = buildIdCursorPage(rows, filters.limit, (row) => row.id);
    const data = await this.attachTicketContext(
      orgId,
      page.data.map((row) => ({
        ...row,
        isRead: row.isRead || (lastReadId > 0 && row.id <= lastReadId),
      })),
    );

    return { data, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }

  private async attachTicketContext(
    orgId: string,
    rows: NotificationListRow[],
  ) {
    const ticketIds = Array.from(
      new Set(
        rows
          .map((row) => extractTicketId(row))
          .filter((id): id is number => id != null),
      ),
    );
    if (ticketIds.length === 0)
      return rows.map((row) => ({
        ...row,
        ticketContext: null as NotificationTicketContext | null,
      }));

    const ticketRows = await this.db
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        priority: tickets.priority,
        status: tickets.status,
        type: tickets.type,
        projectKey: projects.key,
        assigneeId: organizationMembers.userId,
        assigneeName: users.name,
        assigneeFirstName: users.firstName,
        assigneeLastName: users.lastName,
        assigneeImage: users.image,
      })
      .from(tickets)
      .leftJoin(projects, eq(projects.id, tickets.projectId))
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, tickets.orgId),
          eq(organizationMembers.id, tickets.assigneeMembershipId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.id, ticketIds)));

    const byId = new Map<number, NotificationTicketContext>();
    for (const ticket of ticketRows) {
      const ticketKey = ticket.projectKey
        ? `${ticket.projectKey}-${ticket.ticketNumber}`
        : String(ticket.ticketNumber);
      byId.set(ticket.id, {
        ticketId: ticket.id,
        ticketKey,
        priority: ticket.priority ?? null,
        status: ticket.status,
        type: ticket.type,
        assignee: ticket.assigneeId
          ? {
              id: ticket.assigneeId,
              name: ticket.assigneeName ?? null,
              firstName: ticket.assigneeFirstName ?? null,
              lastName: ticket.assigneeLastName ?? null,
              image: ticket.assigneeImage ?? null,
            }
          : null,
      });
    }

    return rows.map((row) => {
      const ticketId = extractTicketId(row);
      return {
        ...row,
        ticketContext: ticketId != null ? (byId.get(ticketId) ?? null) : null,
      };
    });
  }

  unreadCount(orgId: string, userId: string) {
    return this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      "unread-count",
      () => this.queryUnreadCount(orgId, userId),
      CACHE_TTL.SHORT,
    );
  }

  private async queryUnreadCount(orgId: string, userId: string) {
    const { membershipId, lastReadId } = await this.resolveRecipient(orgId, userId);
    const window = this.retentionWindow();
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
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(...conditions));
    return { count: Number(result?.count ?? 0) };
  }
}
