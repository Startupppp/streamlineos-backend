import { and, desc, eq, gte, isNull, lt, or, type SQL } from "drizzle-orm";
import { notifications, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { BroadcastsService } from "./broadcasts.service";
import { ACTOR_COLUMNS, NOTIF_COLUMNS } from "./unified-inbox-projections";
import {
  notificationNotSnoozed,
  notificationWindowEnd,
  notificationWindowStart,
} from "./notification-read-window";
import type { MailService } from "../mail/mail.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type {
  BroadcastInboxItem,
  BuildApprovalInboxItem,
  InboxSourcePosition,
  MailInboxItem,
  NotificationInboxItem,
} from "./dto/unified-inbox.schemas";

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

export const SOURCE_TIMEOUT_MS = 5_000;

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

/**
 * Also keyed on `membership_id` — see `countNotificationUnread` for the numbers.
 * On `user_id` it cost 2,043 blocks to return 20 rows and grew with the tenant.
 */
export function notificationKeyset(
  cursor: InboxSourcePosition | null,
): SQL | undefined {
  if (cursor === null) return undefined;
  if (cursor.t === null) return lt(notifications.id, cursor.id);
  const at = new Date(cursor.t);
  return or(
    lt(notifications.createdAt, at),
    and(eq(notifications.createdAt, at), lt(notifications.id, cursor.id)),
  );
}

export async function fetchNotificationItems(
  db: Db,
  orgId: string,
  membershipId: number | null,
  fetchLimit: number,
  cursor: InboxSourcePosition | null,
  unreadOnly: boolean,
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
        isNull(notifications.archivedAt),
        gte(notifications.createdAt, notificationWindowStart(now)),
        lt(notifications.createdAt, notificationWindowEnd(now)),
        notificationNotSnoozed(now),
        notificationKeyset(cursor),
        unreadOnly ? eq(notifications.isRead, false) : undefined,
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
): Promise<MailSourceBatch> {
  const result = await mail.listMessages(
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

/**
 * Where the mail source should resume, given how much of the batch it fetched
 * was actually delivered.
 *
 * Fully delivered — or nothing fetched at all — and the batch's own
 * `nextMailCursor` is the answer. Partly delivered, and the boundary is
 * re-read: `limit`-bounded, one read, and never on a page that trimmed no
 * mail. Nothing delivered leaves the position untouched, so the same batch is
 * offered again on the next page rather than being skipped.
 */
export async function nextMailPosition(
  mail: MailService,
  orgId: string,
  userId: string,
  membershipId: number | null,
  current: string | null,
  fetched: MailSourceBatch,
  delivered: number,
): Promise<string | null> {
  if (fetched.items.length === 0) return current;
  if (delivered === fetched.items.length) return fetched.nextMailCursor ?? current;
  if (delivered === 0) return current;
  const boundary = await mail.listMessages(
    orgId,
    userId,
    membershipId,
    "inbox",
    "all",
    delivered,
    current ?? undefined,
  );
  return boundary.nextCursor ?? current;
}

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
