import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { notifications, projectApprovals, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { actingMembershipId } from "../../common/auth/principal";
import { assertNever } from "../../common/types/assert-never";
import { MailService } from "../mail/mail.service";
import {
  deduplicate,
  lastDeliveredPosition,
  stableSortItems,
} from "./unified-inbox-projections";
import { notificationNotSnoozed } from "./notification-read-window";
import { BroadcastsService } from "./broadcasts.service";
import {
  SOURCE_TIMEOUT_MS,
  fetchBroadcastItems,
  fetchBuildApprovalItems,
  fetchMailItems,
  fetchNotificationItems,
  nextMailPosition,
  readSourceWithin,
  type MailSourceBatch,
  type SourceRead,
} from "./unified-inbox-sources";
import { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  inboxSourcePosition,
  sameInboxCursorState,
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
  type UnifiedUnreadCount,
} from "./dto/unified-inbox.schemas";

const MAIL_COUNT_SCAN_LIMIT = 100;

const EMPTY_MAIL_BATCH: MailSourceBatch = {
  items: [],
  nextMailCursor: null,
  accountsUnavailable: 0,
  accountsQueried: 0,
};

function skippedSource(kind: InboxKind, reason: string | null): SourceStatus {
  return { kind, included: false, reason, available: true, error: null };
}

function readSource<T>(read: () => Promise<T>): Promise<SourceRead<T>> {
  return readSourceWithin(SOURCE_TIMEOUT_MS, read);
}

function itemsOf<T>(outcome: SourceRead<T[]> | null, fallback: T[]): T[] {
  return outcome !== null && outcome.ok ? outcome.value : fallback;
}

function includedSource(
  kind: InboxKind,
  outcome: SourceRead<unknown> | null,
): SourceStatus {
  if (outcome === null || outcome.ok)
    return { kind, included: true, reason: null, available: true, error: null };
  return { kind, included: true, reason: null, available: false, error: outcome.error };
}

function mailSourceStatus(outcome: SourceRead<MailSourceBatch>): SourceStatus {
  if (!outcome.ok)
    return {
      kind: "mail",
      included: true,
      reason: null,
      available: false,
      error: outcome.error,
    };
  const { accountsUnavailable, accountsQueried, items } = outcome.value;
  if (accountsUnavailable === 0)
    return { kind: "mail", included: true, reason: null, available: true, error: null };
  return {
    kind: "mail",
    included: true,
    reason: null,
    available: items.length > 0,
    error: `${String(accountsUnavailable)} of ${String(accountsQueried)} mail accounts unavailable`,
  };
}

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
    const unreadOnly = query.unreadOnly ?? false;
    const kindsFilter: InboxKind[] =
      query.kinds && query.kinds.length > 0
        ? query.kinds
        : ["notification", "broadcast", "mail", "build_approval"];

    const wantsNotifications = kindsFilter.includes("notification");
    const wantsBroadcasts = kindsFilter.includes("broadcast");
    const wantsMail = kindsFilter.includes("mail");
    const wantsBuildApprovals = kindsFilter.includes("build_approval");

    const mailRequested = wantsMail && !unreadOnly;

    const canViewMail = mailRequested
      ? await this.access.holds(user, "mail:inbox:view")
      : false;

    const canViewBuildApprovals = wantsBuildApprovals
      ? await this.access.holds(user, "build:approvals:view")
      : false;

    const membershipId = actingMembershipId(user.principal);
    const notifPosition = inboxSourcePosition(cursorState.n, cursorState.nt);
    const broadcastPosition = inboxSourcePosition(cursorState.b, cursorState.bt);
    const approvalPosition = inboxSourcePosition(cursorState.a, cursorState.at);

    const [notifOutcome, broadcastOutcome, mailOutcome, approvalOutcome] =
      await Promise.all([
        wantsNotifications
          ? readSource(() =>
              fetchNotificationItems(
                this.db,
                orgId,
                membershipId,
                limit + 1,
                notifPosition,
                unreadOnly,
              ),
            )
          : null,
        wantsBroadcasts
          ? readSource(() =>
              fetchBroadcastItems(
                this.broadcasts,
                orgId,
                userId,
                limit + 1,
                broadcastPosition,
                membershipId,
              ),
            )
          : null,
        mailRequested && canViewMail
          ? readSource(() =>
              fetchMailItems(
                this.mail,
                orgId,
                userId,
                membershipId,
                limit + 1,
                cursorState.m,
              ),
            )
          : null,
        wantsBuildApprovals && canViewBuildApprovals
          ? readSource(() =>
              fetchBuildApprovalItems(
                this.buildApprovals,
                orgId,
                userId,
                membershipId,
                limit + 1,
                approvalPosition,
              ),
            )
          : null,
      ]);

    const emptyNotifications: NotificationInboxItem[] = [];
    const emptyBroadcasts: BroadcastInboxItem[] = [];
    const emptyApprovals: BuildApprovalInboxItem[] = [];

    const notifItems = itemsOf(notifOutcome, emptyNotifications);
    const broadcastItems = itemsOf(broadcastOutcome, emptyBroadcasts);
    const approvalItems = itemsOf(approvalOutcome, emptyApprovals);
    const mailBatch =
      mailOutcome !== null && mailOutcome.ok ? mailOutcome.value : EMPTY_MAIL_BATCH;

    const sources: SourceStatus[] = [
      wantsNotifications
        ? includedSource("notification", notifOutcome)
        : skippedSource("notification", null),
      wantsBroadcasts
        ? includedSource("broadcast", broadcastOutcome)
        : skippedSource("broadcast", null),
      this.mailStatus(wantsMail, unreadOnly, canViewMail, mailOutcome),
      wantsBuildApprovals && canViewBuildApprovals && approvalOutcome !== null
        ? includedSource("build_approval", approvalOutcome)
        : skippedSource(
            "build_approval",
            wantsBuildApprovals && !canViewBuildApprovals
              ? "no permission: build:approvals:view"
              : null,
          ),
    ];

    const merged = stableSortItems([
      ...notifItems,
      ...broadcastItems,
      ...mailBatch.items,
      ...approvalItems,
    ]);

    const deduped = deduplicate(merged);
    const trimmed = deduped.length > limit;
    const page = trimmed ? deduped.slice(0, limit) : deduped;

    const degraded = sources.some(
      (s) => s.included && (!s.available || s.error !== null),
    );
    const hasMore = trimmed || degraded;

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
      deliveredMail < mailBatch.items.length &&
      deliveredMailKeys.has(mailBatch.items[deliveredMail].dedupKey)
    )
      deliveredMail++;

    const notifNext = lastDeliveredPosition(page, "notification");
    const broadcastNext = lastDeliveredPosition(page, "broadcast");
    const approvalNext = lastDeliveredPosition(page, "build_approval");

    const nextState: InboxCursorState = {
      n: notifNext?.id ?? cursorState.n,
      nt: notifNext?.t ?? cursorState.nt,
      b: broadcastNext?.id ?? cursorState.b,
      bt: broadcastNext?.t ?? cursorState.bt,
      m: await nextMailPosition(
        this.mail,
        orgId,
        userId,
        membershipId,
        cursorState.m,
        mailBatch,
        deliveredMail,
      ),
      a: approvalNext?.id ?? cursorState.a,
      at: approvalNext?.t ?? cursorState.at,
    };

    const advanced = !sameInboxCursorState(nextState, cursorState);
    const nextCursor = hasMore && advanced ? encodeInboxCursor(nextState) : null;

    return { items: page, hasMore, nextCursor, sources, degraded };
  }

  private mailStatus(
    wantsMail: boolean,
    unreadOnly: boolean,
    canViewMail: boolean,
    outcome: SourceRead<MailSourceBatch> | null,
  ): SourceStatus {
    if (!wantsMail) return skippedSource("mail", null);
    if (unreadOnly) return skippedSource("mail", "unsupported: unreadOnly");
    if (!canViewMail || outcome === null)
      return skippedSource("mail", "no permission: mail:inbox:view");
    return mailSourceStatus(outcome);
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
          notificationNotSnoozed(new Date()),
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
}
