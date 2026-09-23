import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { actingMembershipId } from "../../common/auth/principal";
import { assertNever } from "../../common/types/assert-never";
import { MailService } from "../mail/mail.service";
import {
  deduplicate,
  lastDeliveredAdapterPositions,
  lastDeliveredPosition,
  stableSortItems,
} from "./unified-inbox-projections";
import { notificationNotSnoozed } from "./notification-read-window";
import { BroadcastsService } from "./broadcasts.service";
import {
  SOURCE_TIMEOUT_MS,
  buildApprovalAdapter,
  fetchBroadcastItems,
  fetchMailItems,
  fetchNotificationItems,
  nextMailPosition,
  readSourceWithin,
  type ApprovalSourceAdapter,
  type InboxFilters,
  type MailSourceBatch,
  type SourceRead,
} from "./unified-inbox-sources";
import { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import {
  ApprovalAdapterRegistry,
  approvalAdapterKey,
} from "../attention/approval-adapter.registry";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { InboxSourcePosition } from "./dto/unified-inbox.schemas";
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

const LEGACY_APPROVAL_ADAPTER_KEY = approvalAdapterKey({
  module: "build",
  kindLabel: "build",
});

const EMPTY_MAIL_BATCH: MailSourceBatch = {
  items: [],
  nextMailCursor: null,
  accountsUnavailable: 0,
  accountsQueried: 0,
};

function skippedSource(kind: InboxKind, reason: string | null): SourceStatus {
  return { kind, included: false, reason, available: true, error: null };
}

function matchesQ(q: string, subject: string, body: string): boolean {
  const lower = q.toLowerCase();
  return (
    subject.toLowerCase().includes(lower) || body.toLowerCase().includes(lower)
  );
}

function applyInMemoryFilters<
  T extends {
    subject: string;
    body?: string;
    category?: string;
    priority?: string;
  },
>(items: T[], filters: InboxFilters): T[] {
  return items.filter((item) => {
    if (filters.q && !matchesQ(filters.q, item.subject, item.body ?? ""))
      return false;
    if (filters.category && item.category !== filters.category) return false;
    if (filters.priority && item.priority !== filters.priority) return false;
    return true;
  });
}

function applyQFilter<T extends { subject: string }>(
  items: T[],
  q: string | undefined,
): T[] {
  if (q === undefined || q.trim() === "") return items;
  return items.filter((item) => matchesQ(q, item.subject, ""));
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
  return {
    kind,
    included: true,
    reason: null,
    available: false,
    error: outcome.error,
  };
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
    return {
      kind: "mail",
      included: true,
      reason: null,
      available: true,
      error: null,
    };
  return {
    kind: "mail",
    included: true,
    reason: null,
    available: items.length > 0,
    error: `${String(accountsUnavailable)} of ${String(accountsQueried)} mail accounts unavailable`,
  };
}

type AdapterFetchResult = {
  items: BuildApprovalInboxItem[];
  errors: string[];
  permDenied: string[];
  unsupportedOnPage2: string[];
  allAdapters: readonly ApprovalSourceAdapter[];
  adapterByDedupKey: Map<string, string>;
};

function buildApprovalSourceStatus(
  wants: boolean,
  approvalsSupport: boolean,
  result: AdapterFetchResult | null,
  searching: boolean,
): SourceStatus {
  if (!wants) return skippedSource("build_approval", null);
  if (!approvalsSupport)
    return skippedSource(
      "build_approval",
      "unsupported: triage (approvals have no archive state)",
    );
  if (result === null) return skippedSource("build_approval", null);
  const { allAdapters, permDenied, errors, unsupportedOnPage2 } = result;
  if (allAdapters.length > 0 && permDenied.length === allAdapters.length)
    return skippedSource(
      "build_approval",
      `no permission: ${permDenied.join(", ")}`,
    );
  const errParts: string[] = [];
  if (errors.length > 0) errParts.push(errors.join("; "));
  if (unsupportedOnPage2.length > 0)
    errParts.push(
      `unsupported: ${unsupportedOnPage2.join(", ")} adapters have no cursor`,
    );
  if (searching)
    errParts.push(
      "unsupported: approvals are searched within the fetched page, not the whole queue",
    );
  return {
    kind: "build_approval",
    included: true,
    reason: null,
    available: errors.length === 0,
    error: errParts.length > 0 ? errParts.join("; ") : null,
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
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  private buildApprovalAdapters(): ApprovalSourceAdapter[] {
    return [buildApprovalAdapter(this.buildApprovals), ...this.registry.list()];
  }

  private async fetchAllAdapters(
    orgId: string,
    userId: string,
    membershipId: number | null,
    user: CurrentUserContext,
    limit: number,
    resuming: boolean,
    positionOf: (adapter: ApprovalSourceAdapter) => InboxSourcePosition | null,
  ): Promise<AdapterFetchResult> {
    const allAdapters = this.buildApprovalAdapters();
    const items: BuildApprovalInboxItem[] = [];
    const errors: string[] = [];
    const permDenied: string[] = [];
    const unsupportedOnPage2: string[] = [];
    const adapterByDedupKey = new Map<string, string>();
    await Promise.all(
      allAdapters.map(async (adapter) => {
        if (resuming && !adapter.supportsAfterCursor) {
          unsupportedOnPage2.push(adapter.kindLabel);
          return;
        }
        const canView = await this.access.holds(user, adapter.permission);
        if (!canView) {
          permDenied.push(adapter.permission);
          return;
        }
        const outcome = await readSource(() =>
          adapter.fetch(
            orgId,
            userId,
            membershipId,
            limit,
            positionOf(adapter),
          ),
        );
        if (!outcome.ok) {
          errors.push(outcome.error);
          return;
        }
        const key = approvalAdapterKey(adapter);
        for (const item of outcome.value)
          adapterByDedupKey.set(item.dedupKey, key);
        items.push(...outcome.value);
      }),
    );
    return {
      items,
      errors,
      permDenied,
      unsupportedOnPage2,
      allAdapters,
      adapterByDedupKey,
    };
  }

  async list(
    orgId: string,
    userId: string,
    query: UnifiedInboxQuery,
    user: CurrentUserContext,
  ): Promise<UnifiedInboxResponse> {
    const limit = Math.min(query.limit ?? 25, 100);
    const cursorState = decodeInboxCursor(query.cursor);
    const unreadOnly = query.unreadOnly ?? false;
    const triage = query.triage ?? "active";
    const filters: InboxFilters = {
      triage,
      q: query.q,
      category: query.category,
      priority: query.priority,
    };
    const kindsFilter: InboxKind[] =
      query.kinds && query.kinds.length > 0
        ? query.kinds
        : ["notification", "broadcast", "mail", "build_approval"];

    const wantsNotifications = kindsFilter.includes("notification");
    const wantsBroadcasts = kindsFilter.includes("broadcast");
    const wantsMail = kindsFilter.includes("mail");
    const wantsBuildApprovals = kindsFilter.includes("build_approval");

    const broadcastsSupport = triage === "active";
    const mailSupport = triage === "active";
    const approvalsSupport = triage === "active";

    const canViewMail =
      wantsMail && mailSupport
        ? await this.access.holds(user, "mail:inbox:view")
        : false;

    let mailFreshForUnreadOnly: boolean | null = null;
    if (unreadOnly && wantsMail && mailSupport && canViewMail) {
      mailFreshForUnreadOnly = await this.mail.areAllAccountsFresh(
        orgId,
        userId,
        "inbox",
      );
    }

    const shouldFetchMail =
      wantsMail &&
      mailSupport &&
      canViewMail &&
      (!unreadOnly || mailFreshForUnreadOnly === true);

    const membershipId = actingMembershipId(user.principal);
    const notifPosition = inboxSourcePosition(cursorState.n, cursorState.nt);
    const broadcastPosition = inboxSourcePosition(
      cursorState.b,
      cursorState.bt,
    );
    const legacyApprovalPosition = inboxSourcePosition(
      cursorState.a,
      cursorState.at,
    );
    const resuming =
      typeof query.cursor === "string" && query.cursor.length > 0;
    const positionOf = (
      adapter: ApprovalSourceAdapter,
    ): InboxSourcePosition | null =>
      cursorState.ap[approvalAdapterKey(adapter)] ??
      (approvalAdapterKey(adapter) === LEGACY_APPROVAL_ADAPTER_KEY
        ? legacyApprovalPosition
        : null);

    const [notifOutcome, broadcastOutcome, mailOutcome, adapterResult] =
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
                filters,
              ),
            )
          : null,
        wantsBroadcasts && broadcastsSupport
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
        shouldFetchMail
          ? readSource(() =>
              fetchMailItems(
                this.mail,
                orgId,
                userId,
                membershipId,
                limit + 1,
                cursorState.m,
                unreadOnly,
                filters.q,
              ),
            )
          : null,
        wantsBuildApprovals && approvalsSupport
          ? this.fetchAllAdapters(
              orgId,
              userId,
              membershipId,
              user,
              limit + 1,
              resuming,
              positionOf,
            )
          : null,
      ]);

    const emptyNotifications: NotificationInboxItem[] = [];
    const emptyBroadcasts: BroadcastInboxItem[] = [];

    const notifItems = itemsOf(notifOutcome, emptyNotifications);
    const rawBroadcastItems = itemsOf(broadcastOutcome, emptyBroadcasts);
    const approvalItems = applyQFilter(adapterResult?.items ?? [], filters.q);
    const mailBatch =
      mailOutcome !== null && mailOutcome.ok
        ? mailOutcome.value
        : EMPTY_MAIL_BATCH;

    const broadcastItems = applyInMemoryFilters(rawBroadcastItems, filters);

    const sources: SourceStatus[] = [
      wantsNotifications
        ? includedSource("notification", notifOutcome)
        : skippedSource("notification", null),
      wantsBroadcasts && broadcastsSupport
        ? includedSource("broadcast", broadcastOutcome)
        : skippedSource(
            "broadcast",
            wantsBroadcasts && !broadcastsSupport
              ? "unsupported: triage (broadcasts have no archive state)"
              : null,
          ),
      this.mailStatus(
        wantsMail,
        unreadOnly,
        triage,
        canViewMail,
        mailFreshForUnreadOnly,
        mailOutcome,
      ),
      buildApprovalSourceStatus(
        wantsBuildApprovals,
        approvalsSupport,
        adapterResult,
        filters.q !== undefined && filters.q.trim() !== "",
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
        unreadOnly,
      ),
      a: approvalNext?.id ?? cursorState.a,
      at: approvalNext?.t ?? cursorState.at,
      ap: lastDeliveredAdapterPositions(
        page,
        cursorState.ap,
        adapterResult?.adapterByDedupKey ?? new Map<string, string>(),
      ),
    };

    const advanced = !sameInboxCursorState(nextState, cursorState);
    const nextCursor =
      hasMore && advanced ? encodeInboxCursor(nextState) : null;

    return { items: page, hasMore, nextCursor, sources, degraded };
  }

  private mailStatus(
    wantsMail: boolean,
    unreadOnly: boolean,
    triage: "active" | "later" | "done",
    canViewMail: boolean,
    freshForUnreadOnly: boolean | null,
    outcome: SourceRead<MailSourceBatch> | null,
  ): SourceStatus {
    if (!wantsMail) return skippedSource("mail", null);
    if (triage !== "active")
      return skippedSource(
        "mail",
        "unsupported: triage (mail has no archive state)",
      );
    if (unreadOnly && freshForUnreadOnly === false)
      return skippedSource(
        "mail",
        "unsupported: unreadOnly (mailbox not synced)",
      );
    if (!canViewMail)
      return skippedSource("mail", "no permission: mail:inbox:view");
    if (outcome === null)
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
    const canMail = await this.access.holds(user, "mail:inbox:view");

    const [notifCount, mailCount, approvalCount] = await Promise.all([
      this.countNotificationUnread(orgId, actingMembershipId(user.principal)),
      canMail
        ? this.countMailUnread(
            orgId,
            userId,
            actingMembershipId(user.principal),
          )
        : Promise.resolve({ unread: 0, exact: true }),
      this.countPendingAcrossAdapters(orgId, userId, user),
    ]);

    return {
      notification: notifCount,
      mail: mailCount.unread,
      approval: approvalCount,
      total: notifCount + mailCount.unread + approvalCount,
      mailExact: mailCount.exact,
    };
  }

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

  private async countMailUnread(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<{ unread: number; exact: boolean }> {
    return this.mail.countUnread(
      orgId,
      userId,
      membershipId,
      "inbox",
      MAIL_COUNT_SCAN_LIMIT,
    );
  }

  private async countPendingAcrossAdapters(
    orgId: string,
    userId: string,
    user: CurrentUserContext,
  ): Promise<number> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId === null) return 0;
    const counts = await Promise.all(
      this.buildApprovalAdapters().map(async (adapter) => {
        if (!(await this.access.holds(user, adapter.permission))) return 0;
        const outcome = await readSource(() =>
          adapter.countPending(orgId, userId, membershipId),
        );
        return outcome.ok ? outcome.value : 0;
      }),
    );
    return counts.reduce((total, n) => total + n, 0);
  }
}
