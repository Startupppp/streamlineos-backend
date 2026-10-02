import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { notifications, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { BroadcastsService } from "./broadcasts.service";
import { ACTOR_COLUMNS, NOTIF_COLUMNS } from "./unified-inbox-projections";
import {
  notificationNotSnoozed,
  notificationWindowEnd,
  notificationWindowStart,
} from "./notification-read-window";
import {
  notificationUnread,
  readByWatermark,
} from "./notification-read-watermark";
import type { MailService } from "../mail/mail.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type {
  BroadcastInboxItem,
  BuildApprovalInboxItem,
  InboxSourcePosition,
  MailInboxItem,
  NotificationInboxItem,
} from "./dto/unified-inbox.schemas";

import type { ApprovalSourceAdapter } from "../attention/approval-adapter.registry";
export type { ApprovalSourceAdapter } from "../attention/approval-adapter.registry";

export type InboxTriage = "active" | "later" | "done";

export type InboxFilters = {
  triage: InboxTriage;
  q: string | undefined;
  category: string | undefined;
  priority: string | undefined;
  eventKeys: readonly string[] | undefined;
  module: string | undefined;
};

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  triage: "active",
  q: undefined,
  category: undefined,
  priority: undefined,
  eventKeys: undefined,
  module: undefined,
};

export const SOURCE_TIMEOUT_MS = 5_000;

export const APPROVAL_COUNT_SCAN_LIMIT = 50;

export type SourceFailure = "timeout" | "source unavailable";

export type SourceRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: SourceFailure };

export type MailSourceBatch = {
  items: MailInboxItem[];
  nextMailCursor: string | null;
  accountsUnavailable: number;
  accountsQueried: number;
};

export async function readSourceWithin<T>(
  timeoutMs: number,
  read: () => Promise<T>,
): Promise<SourceRead<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<SourceRead<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
  });
  const work: Promise<SourceRead<T>> = read().then(
    (value): SourceRead<T> => ({ ok: true, value }),
    (): SourceRead<T> => ({ ok: false, error: "source unavailable" }),
  );
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export function notificationKeyset(
  cursor: InboxSourcePosition | null,
): SQL | undefined {
  if (cursor === null || cursor.t === null) return undefined;
  const at = new Date(cursor.t);
  return or(
    lt(notifications.createdAt, at),
    and(eq(notifications.createdAt, at), lt(notifications.id, cursor.id)),
  );
}

function triageConditions(
  triage: InboxTriage,
  now: Date,
): Array<SQL | undefined> {
  if (triage === "later") {
    return [
      isNull(notifications.archivedAt),
      isNotNull(notifications.snoozedUntil),
      gt(notifications.snoozedUntil, now),
    ];
  }
  if (triage === "done") return [isNotNull(notifications.archivedAt)];

  return [isNull(notifications.archivedAt), notificationNotSnoozed(now)];
}

export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function notificationMatchesQ(q: string | undefined): SQL | undefined {
  if (q === undefined) return undefined;
  const trimmed = q.trim();
  if (trimmed === "") return undefined;
  const pattern = `%${escapeLikeTerm(trimmed)}%`;
  return or(
    sql`${notifications.title} ILIKE ${pattern}`,
    sql`${notifications.message} ILIKE ${pattern}`,
  );
}

export async function fetchNotificationItems(
  db: Db,
  orgId: string,
  membershipId: number | null,
  fetchLimit: number,
  cursor: InboxSourcePosition | null,
  unreadOnly: boolean,
  filters: InboxFilters = DEFAULT_INBOX_FILTERS,
  lastReadId = 0,
): Promise<NotificationInboxItem[]> {
  if (membershipId === null) return [];
  const now = new Date();
  const rows = await db
    .select({ ...NOTIF_COLUMNS, ...ACTOR_COLUMNS })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.membershipId, membershipId),
        isNull(notifications.deletedAt),
        ...triageConditions(filters.triage, now),
        gte(notifications.createdAt, notificationWindowStart(now)),
        lt(notifications.createdAt, notificationWindowEnd(now)),
        notificationKeyset(cursor),
        unreadOnly ? notificationUnread(lastReadId) : undefined,
        filters.category
          ? sql`${notifications.category}::text = ${filters.category}`
          : undefined,
        filters.priority
          ? sql`${notifications.priority}::text = ${filters.priority}`
          : undefined,
        filters.eventKeys && filters.eventKeys.length > 0
          ? inArray(notifications.eventKey, [...filters.eventKeys])
          : undefined,
        filters.module
          ? sql`COALESCE(${notifications.sourceModule}, 'system') = ${filters.module}`
          : undefined,
        notificationMatchesQ(filters.q),
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
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
      isRead: row.isRead || readByWatermark(Number(row.id), lastReadId),
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
  cursor: InboxSourcePosition | null,
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

export async function fetchMailItems(
  mail: MailService,
  orgId: string,
  userId: string,
  membershipId: number | null,
  fetchLimit: number,
  cursor: string | null,
  unreadOnly?: boolean,
  q?: string,
): Promise<MailSourceBatch> {
  const result = await mail.listMessages(
    orgId,
    userId,
    membershipId,
    "inbox",
    "all",
    fetchLimit,
    cursor ?? undefined,
    q,
    unreadOnly,
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
      dedupKey: `mail:${String(msg.accountId)}:${msg.id}`,
      timestamp: msg.date,
      actor: {
        id: msg.from.email,
        name: msg.from.name ?? null,
        image: null,
      },
    }),
  );

  const failed = new Set(result.accountErrors.map((e) => e.accountId));
  const answered = new Set(
    result.messages.map((m) => m.accountId).filter((id) => !failed.has(id)),
  );

  return {
    items,
    nextMailCursor: result.nextCursor,
    accountsUnavailable: failed.size,
    accountsQueried: failed.size + answered.size,
  };
}

export async function nextMailPosition(
  mail: MailService,
  orgId: string,
  userId: string,
  membershipId: number | null,
  current: string | null,
  fetched: MailSourceBatch,
  delivered: number,
  unreadOnly?: boolean,
): Promise<string | null> {
  if (fetched.items.length === 0) return current;
  if (delivered === fetched.items.length)
    return fetched.nextMailCursor ?? current;
  if (delivered === 0) return current;
  const boundary = await mail.listMessages(
    orgId,
    userId,
    membershipId,
    "inbox",
    "all",
    delivered,
    current ?? undefined,
    undefined,
    unreadOnly,
  );
  return boundary.nextCursor ?? current;
}

export const BUILD_APPROVAL_OBJECT_TYPE = "project_approval";

export async function fetchBuildApprovalItems(
  buildApprovals: BuildApprovalsInboxService,
  orgId: string,
  userId: string,
  membershipId: number | null,
  fetchLimit: number,
  cursor: InboxSourcePosition | null,
): Promise<BuildApprovalInboxItem[]> {
  const rows = await buildApprovals.getInboxPage(
    orgId,
    userId,
    membershipId,
    fetchLimit,
    cursor?.id ?? null,
    cursor?.t ?? null,
  );

  return rows.map((row): BuildApprovalInboxItem => {
    const ticketId = row.entityType === "task" ? row.entityId : null;
    return {
      kind: "build_approval",
      id: row.id,
      projectId: row.projectId,
      approvalKind: "build",
      ticketId,
      status: row.status,
      subject: row.title,
      sourceModule: "build",
      actor: null,
      deepLink: buildApprovalDeepLink(row.projectId, ticketId),
      isRead: false,
      objectType: BUILD_APPROVAL_OBJECT_TYPE,
      objectId: String(row.id),
      dedupKey: `approval:build:${String(row.id)}`,
      timestamp: row.createdAt.toISOString(),
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    };
  });
}

export function buildApprovalDeepLink(
  projectId: number | null,
  ticketId: number | null = null,
): string {
  if (projectId === null) return "/build/approvals";
  if (ticketId !== null) {
    return `/build/${String(projectId)}/issues?ticket=${String(ticketId)}`;
  }
  return `/build/approvals?projectId=${String(projectId)}`;
}

export function buildApprovalAdapter(
  buildApprovals: BuildApprovalsInboxService,
): ApprovalSourceAdapter {
  return {
    module: "build",
    permission: "build:approvals:view",
    kindLabel: "build",
    supportsAfterCursor: true,
    fetch: (orgId, userId, membershipId, limit, cursor) =>
      fetchBuildApprovalItems(
        buildApprovals,
        orgId,
        userId,
        membershipId,
        limit,
        cursor,
      ),
  };
}
