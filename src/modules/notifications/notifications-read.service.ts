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
  ilike,
  or,
} from "drizzle-orm";
import { notifications, tickets, projects, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListInput } from "./dto/notification.schemas";
import type { NotificationTicketContext } from "./notifications.types";

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

  list(orgId: string, userId: string, filters: ListInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const section = filters.unreadOnly ? "UNREAD" : (filters.section ?? "ALL");
    const key = `list:${section}:${filters.category ?? ""}:${filters.priority ?? ""}:${limit}:${filters.cursor ?? ""}:${filters.search ?? ""}`;
    return this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      key,
      () =>
        this.queryNotifications(orgId, userId, { ...filters, limit, section }),
      CACHE_TTL.SHORT,
    );
  }

  private async queryNotifications(
    orgId: string,
    userId: string,
    filters: ListInput & { section: string },
  ) {
    const conditions = [
      eq(notifications.orgId, orgId),
      eq(notifications.userId, userId),
      isNull(notifications.deletedAt),
    ];

    switch (filters.section) {
      case "UNREAD":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.isRead, false));
        break;
      case "READ":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.isRead, true));
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
      .limit(filters.limit);

    return this.attachTicketContext(orgId, rows);
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
        assigneeId: users.id,
        assigneeName: users.name,
        assigneeFirstName: users.firstName,
        assigneeLastName: users.lastName,
        assigneeImage: users.image,
      })
      .from(tickets)
      .leftJoin(projects, eq(projects.id, tickets.projectId))
      .leftJoin(users, eq(users.id, tickets.assigneeId))
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
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          isNull(notifications.deletedAt),
          isNull(notifications.archivedAt),
        ),
      );
    return { count: Number(result?.count ?? 0) };
  }
}
