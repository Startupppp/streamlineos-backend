import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { notifications, projectApprovals, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { actingMembershipId } from "../../common/auth/principal";
import { assertNever } from "../../common/types/assert-never";
import { MailService } from "../mail/mail.service";
import { KIND_ORDER, deduplicate, stableSortItems } from "./unified-inbox-projections";
import { BroadcastsService } from "./broadcasts.service";
import { fetchBroadcastItems, fetchNotificationItems } from "./unified-inbox-sources";
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

    const emptyNotifications: NotificationInboxItem[] = [];
    const emptyBroadcasts: BroadcastInboxItem[] = [];
    const emptyMailResult: { items: MailInboxItem[]; nextMailCursor: string | null } = {
      items: [],
      nextMailCursor: null,
    };
    const emptyApprovals: BuildApprovalInboxItem[] = [];

    const [notifItems, broadcastItems, mailResult, approvalItems] =
      await Promise.all([
        wantsNotifications
          ? fetchNotificationItems(
              this.db,
              orgId,
              actingMembershipId(user.principal),
              limit + 1,
              cursorState.n,
              query.unreadOnly ?? false,
            )
          : emptyNotifications,
        wantsBroadcasts
          ? fetchBroadcastItems(this.broadcasts, orgId, userId, limit + 1, cursorState.b, actingMembershipId(user.principal))
          : emptyBroadcasts,
        wantsMail && canViewMail
          ? this.fetchMail(orgId, userId, actingMembershipId(user.principal), limit + 1, cursorState.m)
          : emptyMailResult,
        wantsBuildApprovals && canViewBuildApprovals
          ? this.fetchBuildApprovals(orgId, userId, actingMembershipId(user.principal), limit + 1, cursorState.a)
          : emptyApprovals,
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

    // Mail resumes from the last message actually DELIVERED, the way n/b/a do.
    //
    // It used to resume from `nextMailCursor` — the end of the batch it FETCHED.
    // The merge keeps `limit` items out of four sources fetched at `limit + 1`
    // each, so on any mixed page most of the mail batch is trimmed, and stepping
    // the cursor past the whole batch meant those messages were never delivered
    // to anyone. Silently: the reader sees a full page and scrolls on, and the
    // gap widens by up to a page every time.
    //
    // A mail cursor cannot address a message inside its own batch — it is a map
    // of per-account provider page tokens and skips — so the position after the
    // delivered prefix is asked for rather than computed: one more read of
    // exactly that prefix, whose `nextCursor` is the boundary wanted. It runs
    // only on a page that actually trimmed mail, is bounded by `limit`, and on
    // the mirror path it is the same indexed keyset walk the page itself used.
    //
    // The delivered count is the leading run that reached the page, not the
    // total: the merge orders on (timestamp, kind, id) while the provider orders
    // on date alone, so a timestamp tie could in principle place a later message
    // ahead of an earlier one. Counting the prefix re-delivers that one message
    // rather than skipping the one behind it.
    const deliveredMailKeys = new Set(
      page
        .filter((i): i is MailInboxItem => i.kind === "mail")
        .map((i) => i.dedupKey),
    );
    let deliveredMail = 0;
    while (
      deliveredMail < mailResult.items.length &&
      deliveredMailKeys.has(mailResult.items[deliveredMail].dedupKey)
    )
      deliveredMail++;

    const nextState: InboxCursorState = {
      n: lastNotif ? lastNotif.id : cursorState.n,
      b: lastBroadcast ? lastBroadcast.id : cursorState.b,
      m: await this.nextMailPosition(
        orgId,
        userId,
        actingMembershipId(user.principal),
        cursorState.m,
        mailResult,
        deliveredMail,
      ),
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
  private async nextMailPosition(
    orgId: string,
    userId: string,
    membershipId: number | null,
    current: string | null,
    fetched: { items: MailInboxItem[]; nextMailCursor: string | null },
    delivered: number,
  ): Promise<string | null> {
    if (fetched.items.length === 0) return current;
    if (delivered === fetched.items.length) return fetched.nextMailCursor ?? current;
    if (delivered === 0) return current;
    const boundary = await this.mail.listMessages(
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
      this.countNotificationUnread(orgId, actingMembershipId(user.principal)),
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

  /**
   * Keyed on `membership_id`, not `user_id`, because every index on `notifications`
   * leads `(org_id, membership_id, …)` and none mentions `user_id`.
   *
   * MEASURED on the shipped perf seed (a tenant with 240,000 notifications), as an
   * EXPLAIN (ANALYZE, BUFFERS) of this exact predicate:
   *
   *   user_id       Seq Scan on EVERY monthly partition — 10,231 blocks, 15.4 ms
   *   membership_id Index scan on idx_notifications_unread_count — 24 blocks, 0.5 ms
   *
   * 426x fewer blocks for one integer, and the user_id form grows linearly with the
   * tenant's notification volume, on a badge that every authenticated page renders.
   * This is the unmeasured twin of a defect already fixed once: GET
   * /notifications/unread-count measured 10,234 blocks before it was re-keyed on
   * membership_id and now measures 16 (.github/workflows/ci.yml:928).
   *
   * A principal with no membership (an API token) counts zero rather than scanning:
   * `notifications.membership_id` is the recipient, so there is nothing to count.
   * Rows whose `membership_id` is NULL are excluded, which is the same set
   * `NotificationsReadService.queryUnreadCount` already excludes — the badge and the
   * page it links to now agree instead of differing by those rows.
   */
  private async countNotificationUnread(
    orgId: string,
    membershipId: number | null,
  ): Promise<number> {
    if (membershipId === null) return 0;
    const rows = await this.db
      .select({ cnt: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.isRead, false),
          isNull(notifications.deletedAt),
          isNull(notifications.archivedAt),
        ),
      );
    return Number(rows[0]?.cnt ?? 0);
  }

  /**
   * Counted against `mail_message_metadata` when every connected mailbox's copy
   * of the inbox is fresh, and only then fanned out to the providers — see
   * `MailService.countUnread`. This used to be the fanout unconditionally: a live
   * Gmail/Graph fetch of `MAIL_COUNT_SCAN_LIMIT` messages per account, on a badge
   * every authenticated page renders. The scan limit is now only the cold path's
   * sample size.
   */
  private async countMailUnread(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<{ unread: number; exact: boolean }> {
    return this.mail.countUnread(orgId, userId, membershipId, "inbox", MAIL_COUNT_SCAN_LIMIT);
  }

  private async countApprovalPending(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(projectApprovals)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, projectApprovals.orgId),
          eq(organizationMembers.id, projectApprovals.approverMembershipId),
        ),
      )
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(organizationMembers.userId, userId),
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
