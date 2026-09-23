jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { matchesPredicate, type FakeRow } from "../../test/sql-predicate";
import { UnifiedInboxService } from "./unified-inbox.service";
import { NotificationsReadService } from "./notifications-read.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { listSchema } from "./dto/notification.schemas";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-1";
const UID = "user-1";
const MEMBERSHIP = 7;
const HOUR_MS = 3_600_000;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * HOUR_MS);
}

function fromNow(hours: number): Date {
  return new Date(Date.now() + hours * HOUR_MS);
}

interface NotifOverrides {
  id: number;
  created_at?: Date;
  snoozed_until?: Date | null;
  archived_at?: Date | null;
  is_read?: boolean;
}

function notifRow(overrides: NotifOverrides): FakeRow {
  return {
    id: overrides.id,
    org_id: ORG,
    user_id: null,
    membership_id: MEMBERSHIP,
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    source_module: "system",
    event_key: null,
    entity_type: null,
    entity_id: null,
    actor_user_id: null,
    reason: null,
    title: `Notif ${String(overrides.id)}`,
    message: `Body ${String(overrides.id)}`,
    link: null,
    is_read: overrides.is_read ?? false,
    pinned: false,
    metadata: null,
    channel: "IN_APP",
    archived_at: overrides.archived_at ?? null,
    snoozed_until: overrides.snoozed_until ?? null,
    deleted_at: null,
    created_at: overrides.created_at ?? hoursAgo(1),
  };
}

interface CountChain {
  from: () => CountChain;
  leftJoin: () => CountChain;
  innerJoin: () => CountChain;
  where: (predicate: SQL) => Promise<{ cnt: number }[]>;
}

function makeDb(rows: FakeRow[]): Db {
  const tables: TableRows = {
    notifications: rows,
    users: [],
    organization_members: [
      { id: MEMBERSHIP, org_id: ORG, user_id: UID, role: "MEMBER", status: "ACTIVE" },
    ],
    notification_read_watermarks: [],
  };
  const fake = makeFakeDb(tables);
  const select = (projection?: Record<string, unknown>) => {
    if (projection === undefined || !("cnt" in projection))
      return fake.select(projection);
    const chain: CountChain = {
      from: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: (predicate: SQL) =>
        Promise.resolve([
          {
            cnt: rows.filter((row) =>
              matchesPredicate(predicate, { notifications: [row] }),
            ).length,
          },
        ]),
    };
    return chain;
  };
  return { select } as unknown as Db;
}

function makeAccess(): AccessService {
  return { holds: jest.fn().mockResolvedValue(false) } as unknown as AccessService;
}

function makeMail(): MailService {
  return {
    listMessages: jest
      .fn()
      .mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
  } as unknown as MailService;
}

function makeBroadcasts(): BroadcastsService {
  return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
}

function makeUser(): CurrentUserContext {
  return {
    userId: UID,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: MEMBERSHIP, isOrgOwner: false },
  } as CurrentUserContext;
}

function makeUnified(rows: FakeRow[]): UnifiedInboxService {
  return new UnifiedInboxService(
    makeDb(rows),
    makeAccess(),
    makeMail(),
    makeBroadcasts(),
    makeBuildApprovals(),
  makeRegistry()
  );
}

function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import("../attention/approval-adapter.registry").ApprovalAdapterRegistry;
}


function makeRead(rows: FakeRow[]): NotificationsReadService {
  const cache = {
    cachedVersioned: (_ns: string, _key: string, load: () => unknown) =>
      Promise.resolve(load()),
  } as never;
  return new NotificationsReadService(
    makeDb(rows),
    cache,
    new NotificationVisibilityRegistry(),
  );
}

async function unifiedIds(svc: UnifiedInboxService): Promise<(string | number)[]> {
  const page = await svc.list(
    ORG,
    UID,
    { limit: 25, kinds: ["notification"], unreadOnly: false, eventKeys: undefined },
    makeUser(),
  );
  return page.items.map((item) => item.id);
}

describe("unified inbox — snooze suppresses a row in the feed and the badge", () => {
  it("BITE: hides a row snoozed into the future from the unified feed", async () => {
    const rows = [
      notifRow({ id: 3, snoozed_until: fromNow(1) }),
      notifRow({ id: 2, snoozed_until: hoursAgo(1) }),
      notifRow({ id: 1 }),
    ];

    expect(await unifiedIds(makeUnified(rows))).toEqual([2, 1]);
  });

  it("BITE: excludes a snoozed row from the unified unread badge", async () => {
    const rows = [
      notifRow({ id: 3, snoozed_until: fromNow(1) }),
      notifRow({ id: 2, snoozed_until: hoursAgo(1) }),
      notifRow({ id: 1 }),
    ];

    const count = await makeUnified(rows).unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.notification).toBe(2);
    expect(count.total).toBe(2);
  });

  it("the feed and the badge agree on exactly which rows a snooze hides", async () => {
    const rows = [
      notifRow({ id: 3, snoozed_until: fromNow(1) }),
      notifRow({ id: 2, snoozed_until: hoursAgo(1) }),
      notifRow({ id: 1 }),
    ];
    const svc = makeUnified(rows);

    const items = await unifiedIds(svc);
    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.notification).toBe(items.length);
  });

  it("BITE: the row returns to the feed and the badge once its deadline passes", async () => {
    const past = [notifRow({ id: 9, snoozed_until: fromNow(1) })];
    const hidden = makeUnified(past);
    expect(await unifiedIds(hidden)).toEqual([]);
    expect((await hidden.unifiedUnreadCount(ORG, UID, makeUser())).notification).toBe(0);

    const due = [notifRow({ id: 9, snoozed_until: hoursAgo(1) })];
    const shown = makeUnified(due);
    expect(await unifiedIds(shown)).toEqual([9]);
    expect((await shown.unifiedUnreadCount(ORG, UID, makeUser())).notification).toBe(1);
  });

  it("a snoozed row stays unread, so nothing is silently marked read to hide it", async () => {
    const rows = [notifRow({ id: 9, snoozed_until: fromNow(1) })];

    const count = await makeUnified(rows).unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.notification).toBe(0);
    expect(rows[0]?.["is_read"]).toBe(false);
  });

  it("ARCHIVED still returns a snoozed row — the unified feed never shows archived rows at all", async () => {
    const archivedSnoozed = notifRow({
      id: 6,
      archived_at: hoursAgo(2),
      snoozed_until: fromNow(1),
    });

    const archived = await makeRead([archivedSnoozed]).list(
      ORG,
      UID,
      listSchema.parse({ section: "ARCHIVED" }),
    );

    expect(archived.data.map((row) => row.id)).toEqual([6]);
    expect(await unifiedIds(makeUnified([archivedSnoozed]))).toEqual([]);
  });
});
