import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { notifications, projectApprovals, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { actingMembershipId } from "../../common/auth/principal";
import { MailService } from "../mail/mail.service";
import { BroadcastsService } from "./broadcasts.service";
import { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  type BroadcastInboxItem,
  type BuildApprovalInboxItem,
  type InboxCursorState,
  type InboxKind,
  type MailInboxItem,
  type NotificationInboxItem,
  type SourceStatus,
  type UnifiedInboxItem,
  type UnifiedInboxQuery,
  type UnifiedInboxResponse,
} from "./dto/unified-inbox.schemas";

export type UnifiedUnreadCount = {
  notification: number;
  mail: number;
  approval: number;
  total: number;
  mailExact: boolean;
};

const MAIL_COUNT_SCAN_LIMIT = 100;

function assertNever(x: never): never {
  throw new Error(`Unhandled union member: ${String(x)}`);
}

const KIND_ORDER: Record<InboxKind, number> = {
  notification: 0,
  broadcast: 1,
  mail: 2,
  build_approval: 3,
};

function stableSortItems(items: UnifiedInboxItem[]): UnifiedInboxItem[] {
  return [...items].sort((a, b) => {
    const tDiff = b.timestamp.localeCompare(a.timestamp);
    if (tDiff !== 0) return tDiff;
    const kDiff = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    if (kDiff !== 0) return kDiff;
    return String(b.id).localeCompare(String(a.id));
  });
}

function deduplicate(items: UnifiedInboxItem[]): UnifiedInboxItem[] {
  const seen = new Set<string>();
  const out: UnifiedInboxItem[] = [];
  for (const item of items) {
    if (!seen.has(item.dedupKey)) {
      seen.add(item.dedupKey);
      out.push(item);
    }
  }
  return out;
}

const NOTIF_COLUMNS = {
  id: notifications.id,
  type: notifications.type,
  priority: notifications.priority,
  category: notifications.category,
  sourceModule: notifications.sourceModule,
  eventKey: notifications.eventKey,
  title: notifications.title,
  message: notifications.message,
  link: notifications.link,
  isRead: notifications.isRead,
  pinned: notifications.pinned,
  createdAt: notifications.createdAt,
  actorUserId: notifications.actorUserId,
} as const;

const ACTOR_COLUMNS = {
  actorId: users.id,
  actorName: users.name,
  actorImage: users.image,
} as const;

@Injectable()
export class UnifiedInboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly mail: MailService,
    private readonly broadcasts: BroadcastsService,
    private readonly buildApprovals: BuildApprovalsInboxService,
  ) {}

  async list(
    orgId: string,
    userId: string,
    query: UnifiedInboxQuery,
    user: CurrentUserContext,
  ): Promise<UnifiedInboxResponse> {
    const limit = Math.min(query.limit ?? 25, 100);
    const cursorState = decodeInboxCursor(query.cursor);
    const kindsFilter: InboxKind[] =
      query.kinds && query.kinds.length > 0
        ? query.kinds
        : ["notification", "broadcast", "mail", "build_approval"];

    const wantsNotifications = kindsFilter.includes("notification");
    const wantsBroadcasts = kindsFilter.includes("broadcast");
    const wantsMail = kindsFilter.includes("mail");
    const wantsBuildApprovals = kindsFilter.includes("build_approval");

    const canViewMail = wantsMail
      ? await this.access.holds(user, "mail:inbox:view")
      : false;

    const canViewBuildApprovals = wantsBuildApprovals
      ? await this.access.holds(user, "build:approvals:view")
      : false;

    const sources: SourceStatus[] = [
      { kind: "notification", included: wantsNotifications, reason: null },
      { kind: "broadcast", included: wantsBroadcasts, reason: null },
      {
        kind: "mail",
        included: wantsMail && canViewMail,
        reason:
          wantsMail && !canViewMail ? "no permission: mail:inbox:view" : null,
      },
      {
        kind: "build_approval",
        included: wantsBuildApprovals && canViewBuildApprovals,
        reason:
          wantsBuildApprovals && !canViewBuildApprovals
            ? "no permission: build:approvals:view"
            : null,
      },
    ];

    const [notifItems, broadcastItems, mailResult, approvalItems] =
      await Promise.all([
        wantsNotifications
          ? this.fetchNotifications(
              orgId,
              userId,
              limit + 1,
              cursorState.n,
              query.unreadOnly ?? false,
            )
          : ([] as NotificationInboxItem[]),
        wantsBroadcasts
          ? this.fetchBroadcasts(orgId, userId, limit + 1, cursorState.b, actingMembershipId(user.principal))
          : ([] as BroadcastInboxItem[]),
        wantsMail && canViewMail
          ? this.fetchMail(orgId, userId, actingMembershipId(user.principal), limit + 1, cursorState.m)
          : {
              items: [] as MailInboxItem[],
              nextMailCursor: null as string | null,
            },
        wantsBuildApprovals && canViewBuildApprovals
          ? this.fetchBuildApprovals(orgId, userId, actingMembershipId(user.principal), limit + 1, cursorState.a)
          : ([] as BuildApprovalInboxItem[]),
      ]);

    const merged = stableSortItems([
      ...notifItems,
      ...broadcastItems,
      ...mailResult.items,
      ...approvalItems,
    ]);

    const deduped = deduplicate(merged);
    const hasMore = deduped.length > limit;
    const page = hasMore ? deduped.slice(0, limit) : deduped;

    const lastNotif = [...page]
      .reverse()
      .find((i): i is NotificationInboxItem => i.kind === "notification");
    const lastBroadcast = [...page]
      .reverse()
      .find((i): i is BroadcastInboxItem => i.kind === "broadcast");
    const lastMail = [...page]
      .reverse()
      .find((i): i is MailInboxItem => i.kind === "mail");
    const lastApproval = [...page]
      .reverse()
      .find((i): i is BuildApprovalInboxItem => i.kind === "build_approval");

    const nextState: InboxCursorState = {
      n: lastNotif ? lastNotif.id : cursorState.n,
      b: lastBroadcast ? lastBroadcast.id : cursorState.b,
      m: lastMail
        ? (mailResult.nextMailCursor ?? cursorState.m)
        : cursorState.m,
      a: lastApproval ? lastApproval.id : cursorState.a,
    };

    const nextCursor = hasMore ? encodeInboxCursor(nextState) : null;

    return { items: page, hasMore, nextCursor, sources };
  }

  inboxItemKind(item: UnifiedInboxItem): string {
    switch (item.kind) {
      case "notification":
        return "notification";
      case "broadcast":
        return "broadcast";
      case "mail":
        return "mail";
      case "build_approval":
        return "build_approval";
      default:
        return assertNever(item);
    }
  }

  private async fetchNotifications(
    orgId: string,
    userId: string,
    fetchLimit: number,
    cursor: number | null,
    unreadOnly: boolean,
  ): Promise<NotificationInboxItem[]> {
    const rows = await this.db
      .select({ ...NOTIF_COLUMNS, ...ACTOR_COLUMNS })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.actorUserId))
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
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

  private async fetchBroadcasts(
    orgId: string,
    userId: string,
    fetchLimit: number,
    cursor: number | null,
    membershipId?: number | null,
  ): Promise<BroadcastInboxItem[]> {
    const rows = await this.broadcasts.listInboxPage(
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

  private async fetchMail(
    orgId: string,
    userId: string,
    membershipId: number | null,
    fetchLimit: number,
    cursor: string | null,
  ): Promise<{ items: MailInboxItem[]; nextMailCursor: string | null }> {
    const result = await this.mail.listMessages(
      orgId,
      userId,
      membershipId,
      "inbox",
      "all",
      fetchLimit,
      cursor ?? undefined,
    );

    const items: MailInboxItem[] = result.messages.map(
      (msg): MailInboxItem => ({
        kind: "mail",
        id: msg.id,
        threadId: msg.threadId ?? null,
        accountId: msg.accountId,
        sourceModule: "mail",
        subject: msg.subject,
        snippet: msg.snippet,
        hasAttachments: msg.hasAttachments,
        deepLink: null,
        isRead: msg.isRead,
        dedupKey: `mail:${msg.accountId}:${msg.id}`,
        timestamp: msg.date,
        actor: {
          id: msg.from.email,
          name: msg.from.name ?? null,
          image: null,
        },
      }),
    );

    return { items, nextMailCursor: result.nextCursor };
  }

  async unifiedUnreadCount(
    orgId: string,
    userId: string,
    user: CurrentUserContext,
  ): Promise<UnifiedUnreadCount> {
    const [canMail, canApproval] = await Promise.all([
      this.access.holds(user, "mail:inbox:view"),
      this.access.holds(user, "build:approvals:view"),
    ]);

    const [notifCount, mailCount, approvalCount] = await Promise.all([
      this.countNotificationUnread(orgId, userId),
      canMail
        ? this.countMailUnread(orgId, userId, actingMembershipId(user.principal))
        : Promise.resolve({ unread: 0, exact: true }),
      canApproval ? this.countApprovalPending(orgId, userId) : Promise.resolve(0),
    ]);

    return {
      notification: notifCount,
      mail: mailCount.unread,
      approval: approvalCount,
      total: notifCount + mailCount.unread + approvalCount,
      mailExact: mailCount.exact,
    };
  }

  private async countNotificationUnread(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
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
    return Number(rows[0]?.cnt ?? 0);
  }

  private async countMailUnread(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<{ unread: number; exact: boolean }> {
    const result = await this.mail.listMessages(
      orgId,
      userId,
      membershipId,
      "inbox",
      "all",
      MAIL_COUNT_SCAN_LIMIT,
      undefined,
    );
    return {
      unread: result.messages.filter((m) => !m.isRead).length,
      exact: result.messages.length < MAIL_COUNT_SCAN_LIMIT,
    };
  }

  private async countApprovalPending(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(projectApprovals.approverId, userId),
          inArray(projectApprovals.status, ["pending", "escalated"]),
          isNull(projectApprovals.deletedAt),
        ),
      );
    return Number(rows[0]?.cnt ?? 0);
  }

  private async fetchBuildApprovals(
    orgId: string,
    userId: string,
    membershipId: number | null,
    fetchLimit: number,
    cursor: number | null,
  ): Promise<BuildApprovalInboxItem[]> {
    const rows = await this.buildApprovals.getInboxPage(
      orgId,
      userId,
      membershipId,
      fetchLimit,
      cursor,
    );

    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        projectId: row.projectId,
        ticketId: row.entityType === "task" ? row.entityId : null,
        status: row.status,
        subject: row.title,
        sourceModule: "build",
        actor: null,
        deepLink: null,
        isRead: false,
        dedupKey: `approval:${String(row.id)}`,
        timestamp: row.createdAt.toISOString(),
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      }),
    );
  }
}
