import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notifications, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { MailService } from "../mail/mail.service";
import { BroadcastsService } from "./broadcasts.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  type BroadcastInboxItem,
  type InboxCursorState,
  type InboxKind,
  type MailInboxItem,
  type NotificationInboxItem,
  type SourceStatus,
  type UnifiedInboxItem,
  type UnifiedInboxQuery,
  type UnifiedInboxResponse,
} from "./dto/unified-inbox.schemas";

function assertNever(x: never): never {
  throw new Error(`Unhandled union member: ${String(x)}`);
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

    const canViewMail = wantsMail
      ? await this.access.holds(user, "mail:inbox:view")
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
      { kind: "build_approval", included: false, reason: "integration-pending" },
    ];

    const [notifItems, broadcastItems, mailResult] = await Promise.all([
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
        ? this.fetchBroadcasts(orgId, userId, limit + 1, cursorState.b)
        : ([] as BroadcastInboxItem[]),
      wantsMail && canViewMail
        ? this.fetchMail(orgId, userId, limit + 1, cursorState.m)
        : { items: [] as MailInboxItem[], nextMailCursor: null as string | null },
    ]);

    const all: UnifiedInboxItem[] = [
      ...notifItems,
      ...broadcastItems,
      ...mailResult.items,
    ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const hasMore = all.length > limit;
    const page = hasMore ? all.slice(0, limit) : all;

    const lastNotif = [...page]
      .reverse()
      .find((i): i is NotificationInboxItem => i.kind === "notification");
    const lastBroadcast = [...page]
      .reverse()
      .find((i): i is BroadcastInboxItem => i.kind === "broadcast");
    const lastMail = [...page]
      .reverse()
      .find((i): i is MailInboxItem => i.kind === "mail");

    const nextState: InboxCursorState = {
      n: lastNotif ? lastNotif.id : cursorState.n,
      b: lastBroadcast ? lastBroadcast.id : cursorState.b,
      m: lastMail
        ? (mailResult.nextMailCursor ?? cursorState.m)
        : cursorState.m,
    };

    const nextCursor = hasMore ? encodeInboxCursor(nextState) : null;

    return { items: page, nextCursor, sources };
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
  ): Promise<BroadcastInboxItem[]> {
    const rows = await this.broadcasts.listInboxPage(
      orgId,
      userId,
      fetchLimit,
      cursor,
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
        timestamp: (row.sentAt ?? row.createdAt).toISOString(),
        actor: null,
      }),
    );
  }

  private async fetchMail(
    orgId: string,
    userId: string,
    fetchLimit: number,
    cursor: string | null,
  ): Promise<{ items: MailInboxItem[]; nextMailCursor: string | null }> {
    const result = await this.mail.listMessages(
      orgId,
      userId,
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
}
