jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import type { FakeRow } from "../../test/sql-predicate";
import { UnifiedInboxService } from "./unified-inbox.service";
import { fetchNotificationItems } from "./unified-inbox-sources";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import { BroadcastsService } from "./broadcasts.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { NotificationDispatchService } from "./notification-dispatch.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  type InboxKind,
  type InboxSourcePosition,
} from "./dto/unified-inbox.schemas";

const ORG = "org-1";
const UID = "user-1";
const MEMBERSHIP = 1;
const DAY_MS = 86_400_000;
const ORIGIN = Date.now();

function daysAgo(days: number): Date {
  return new Date(ORIGIN - days * DAY_MS);
}

type NotifSeed = { id: number; createdAt: Date };
type BroadcastSeed = { id: number; sentAt: Date };
type MailSeed = { id: string; accountId: number; at: Date };

function beforePosition(
  row: { id: number; at: Date },
  cursor: InboxSourcePosition | null,
): boolean {
  if (cursor === null) return true;
  if (cursor.t === null) return row.id < cursor.id;
  const bound = new Date(cursor.t).getTime();
  const at = row.at.getTime();
  return at < bound || (at === bound && row.id < cursor.id);
}

function byPositionDesc(
  left: { id: number; at: Date },
  right: { id: number; at: Date },
): number {
  return right.at.getTime() - left.at.getTime() || right.id - left.id;
}

function notifRow(seed: NotifSeed): FakeRow {
  return {
    id: seed.id,
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
    title: `Notif ${String(seed.id)}`,
    message: `Body ${String(seed.id)}`,
    link: null,
    is_read: false,
    pinned: false,
    metadata: null,
    channel: "IN_APP",
    archived_at: null,
    snoozed_until: null,
    deleted_at: null,
    created_at: seed.createdAt,
  };
}

function broadcastRow(seed: BroadcastSeed) {
  return {
    id: seed.id,
    title: `Broadcast ${String(seed.id)}`,
    message: `Broadcast body ${String(seed.id)}`,
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sentAt: seed.sentAt,
    createdAt: seed.sentAt,
  };
}

function mailMessage(seed: MailSeed) {
  return {
    id: seed.id,
    threadId: `t-${seed.id}`,
    accountId: seed.accountId,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Mail ${seed.id}`,
    snippet: "snippet",
    date: seed.at.toISOString(),
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

function makeNotificationDb(seeds: NotifSeed[]): {
  db: Db;
  rows: FakeRow[];
  resort: () => void;
} {
  const rows: FakeRow[] = [];
  const tables: TableRows = { notifications: rows, users: [] };
  const createdAtOf = (row: FakeRow): number => {
    const value = row["created_at"];
    return value instanceof Date ? value.getTime() : 0;
  };
  const resort = () => {
    rows.sort(
      (left, right) =>
        createdAtOf(right) - createdAtOf(left) ||
        Number(right["id"]) - Number(left["id"]),
    );
  };
  for (const seed of seeds) rows.push(notifRow(seed));
  resort();
  return { db: makeFakeDb(tables) as unknown as Db, rows, resort };
}

function makeBroadcasts(seeds: BroadcastSeed[]): { service: BroadcastsService } {
  const live = [...seeds];
  const listInboxPage = jest.fn().mockImplementation(
    (
      _orgId: string,
      _userId: string,
      take: number,
      cursor: InboxSourcePosition | null,
    ) =>
      Promise.resolve(
        live
          .filter((seed) => beforePosition({ id: seed.id, at: seed.sentAt }, cursor))
          .sort((left, right) =>
            byPositionDesc(
              { id: left.id, at: left.sentAt },
              { id: right.id, at: right.sentAt },
            ),
          )
          .slice(0, take)
          .map(broadcastRow),
      ),
  );
  return { service: { listInboxPage } as unknown as BroadcastsService };
}

function makeAccess(mail = false): AccessService {
  return {
    holds: jest
      .fn()
      .mockImplementation((_user: unknown, key: string) =>
        Promise.resolve(key === "mail:inbox:view" ? mail : false),
      ),
  } as unknown as AccessService;
}

function makeMail(seeds: MailSeed[] = []): MailService {
  return {
    listMessages: jest
      .fn()
      .mockImplementation(
        (
          _orgId: string,
          _userId: string,
          _membershipId: number | null,
          _folder: string,
          _filter: string,
          take: number,
          cursor?: string,
        ) => {
          const offset = cursor === undefined ? 0 : Number(cursor);
          const slice = seeds.slice(offset, offset + take);
          const consumed = offset + slice.length;
          return Promise.resolve({
            messages: slice.map(mailMessage),
            nextCursor: consumed < seeds.length ? String(consumed) : null,
            accountErrors: [],
          });
        },
      ),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
  } as unknown as MailService;
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockResolvedValue([]),
  } as unknown as BuildApprovalsInboxService;
}

function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import('../attention/approval-adapter.registry').ApprovalAdapterRegistry;
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

interface ScrollOptions {
  notifications?: NotifSeed[];
  broadcasts?: BroadcastSeed[];
  mail?: MailSeed[];
  kinds: InboxKind[];
  limit: number;
  pages: number;
  afterFirstPage?: (notifications: ReturnType<typeof makeNotificationDb>) => void;
}

async function scroll(options: ScrollOptions): Promise<string[]> {
  const notifications = makeNotificationDb(options.notifications ?? []);
  const svc = new UnifiedInboxService(
    notifications.db,
    makeAccess(options.mail !== undefined),
    makeMail(options.mail ?? []),
    makeBroadcasts(options.broadcasts ?? []).service,
    makeBuildApprovals(),
  makeRegistry()
  );
  const user = makeUser();
  const delivered: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < options.pages; page++) {
    const result = await svc.list(
      ORG,
      UID,
      { limit: options.limit, kinds: options.kinds, unreadOnly: false, cursor },
      user,
    );
    for (const item of result.items) delivered.push(item.dedupKey);
    if (page === 0 && options.afterFirstPage) options.afterFirstPage(notifications);
    if (!result.hasMore || result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  return delivered;
}

const NONMONOTONIC: NotifSeed[] = [
  { id: 10, createdAt: daysAgo(2) },
  { id: 30, createdAt: daysAgo(4) },
  { id: 20, createdAt: daysAgo(10) },
];

describe("unified inbox — keyset ordering agrees with the sources", () => {
  it("BITE: delivers every row of an id-nonmonotonic source across a complete scroll", async () => {
    const delivered = await scroll({
      notifications: NONMONOTONIC,
      kinds: ["notification"],
      limit: 2,
      pages: 10,
    });

    expect(delivered).toEqual([
      "notification:10",
      "notification:30",
      "notification:20",
    ]);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("advances the notification cursor to the position of the LAST row delivered", async () => {
    const notifications = makeNotificationDb(NONMONOTONIC);
    const svc = new UnifiedInboxService(
      notifications.db,
      makeAccess(),
      makeMail(),
      makeBroadcasts([]).service,
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 2, kinds: ["notification"], unreadOnly: false },
      makeUser(),
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual([
      "notification:10",
      "notification:30",
    ]);
    const state = decodeInboxCursor(result.nextCursor);
    expect(state.n).toBe(30);
    expect(state.nt).toBe(daysAgo(4).toISOString());
  });

  it("orders the notification source by the same (timestamp, id) key its cursor bounds", async () => {
    const dialect = new PgDialect();
    let orderBySql = "";
    let whereSql = "";
    const chain: Record<string, jest.Mock> = {};
    chain["from"] = jest.fn(() => chain);
    chain["leftJoin"] = jest.fn(() => chain);
    chain["where"] = jest.fn((predicate: SQL) => {
      whereSql = dialect.sqlToQuery(predicate).sql;
      return chain;
    });
    chain["orderBy"] = jest.fn((...columns: SQL[]) => {
      orderBySql = columns.map((column) => dialect.sqlToQuery(column).sql).join(", ");
      return chain;
    });
    chain["limit"] = jest.fn(() => Promise.resolve([]));
    const db = { select: jest.fn(() => chain) } as unknown as Db;

    await fetchNotificationItems(db, ORG, MEMBERSHIP, 5, {
      id: 30,
      t: daysAgo(4).toISOString(),
    }, false);

    const timeRank = orderBySql.indexOf('"notifications"."created_at" desc');
    const idRank = orderBySql.indexOf('"notifications"."id" desc');
    expect(timeRank).toBeGreaterThanOrEqual(0);
    expect(idRank).toBeGreaterThan(timeRank);
    expect(whereSql).toContain('"notifications"."created_at" < $');
    expect(whereSql).toContain('"notifications"."created_at" = $');
    expect(whereSql).toContain('"notifications"."id" < $');
  });

  it("orders the broadcast source by the same (sent_at, id) key its cursor bounds", async () => {
    const dialect = new PgDialect();
    const captured: { orderBy: string; where: string[] } = { orderBy: "", where: [] };
    const chain: Record<string, jest.Mock> = {};
    const passthrough = () => chain;
    chain["from"] = jest.fn(passthrough);
    chain["leftJoin"] = jest.fn(passthrough);
    chain["innerJoin"] = jest.fn(passthrough);
    chain["where"] = jest.fn((predicate?: SQL) => {
      if (predicate !== undefined) captured.where.push(dialect.sqlToQuery(predicate).sql);
      return chain;
    });
    chain["orderBy"] = jest.fn((...columns: SQL[]) => {
      captured.orderBy = columns.map((column) => dialect.sqlToQuery(column).sql).join(", ");
      return chain;
    });
    chain["limit"] = jest.fn(() => Promise.resolve([]));
    const db = { select: jest.fn(() => chain) } as unknown as Db;
    const service = new BroadcastsService(
      db,
      {} as unknown as CacheService,
      {} as unknown as AuditService,
      {} as unknown as NotificationDispatchService,
    );

    await service.listInboxPage(ORG, UID, 5, { id: 5, t: daysAgo(3).toISOString() }, MEMBERSHIP);

    expect(captured.orderBy).toContain("coalesce");
    const timeRank = captured.orderBy.indexOf("desc");
    const idRank = captured.orderBy.indexOf('"broadcasts"."id" desc');
    expect(idRank).toBeGreaterThan(timeRank);
    const inboxWhere = captured.where.at(-1) ?? "";
    expect(inboxWhere).toContain("coalesce");
    expect(inboxWhere).toContain("::timestamptz");
    expect(inboxWhere).toContain('"broadcasts"."id" < $');
  });

  it("BITE: delivers both of two notifications that share a timestamp", async () => {
    const sameInstant = daysAgo(1);
    const delivered = await scroll({
      notifications: [
        { id: 9, createdAt: sameInstant },
        { id: 10, createdAt: sameInstant },
      ],
      kinds: ["notification"],
      limit: 1,
      pages: 6,
    });

    expect(delivered).toEqual(["notification:10", "notification:9"]);
  });

  it("BITE: delivers every row when two kinds interleave and neither is id-monotonic", async () => {
    const delivered = await scroll({
      notifications: NONMONOTONIC,
      broadcasts: [
        { id: 5, sentAt: daysAgo(3) },
        { id: 9, sentAt: daysAgo(7) },
        { id: 7, sentAt: daysAgo(11) },
      ],
      kinds: ["notification", "broadcast"],
      limit: 2,
      pages: 12,
    });

    expect(delivered).toEqual([
      "notification:10",
      "broadcast:5",
      "notification:30",
      "broadcast:9",
      "notification:20",
      "broadcast:7",
    ]);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("BITE: delivers every row across three kinds with account-qualified mail ids", async () => {
    const delivered = await scroll({
      notifications: NONMONOTONIC,
      broadcasts: [{ id: 5, sentAt: daysAgo(3) }],
      mail: [
        { id: "AAA&b#c", accountId: 2, at: daysAgo(5) },
        { id: "AAA&b#c", accountId: 3, at: daysAgo(9) },
      ],
      kinds: ["notification", "broadcast", "mail"],
      limit: 2,
      pages: 12,
    });

    expect(delivered).toEqual([
      "notification:10",
      "broadcast:5",
      "notification:30",
      "mail:2:AAA&b#c",
      "mail:3:AAA&b#c",
      "notification:20",
    ]);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("keeps paging when the row the cursor names is deleted between pages", async () => {
    const delivered = await scroll({
      notifications: NONMONOTONIC,
      kinds: ["notification"],
      limit: 2,
      pages: 10,
      afterFirstPage: (notifications) => {
        const index = notifications.rows.findIndex((row) => Number(row["id"]) === 30);
        notifications.rows.splice(index, 1);
      },
    });

    expect(delivered).toEqual([
      "notification:10",
      "notification:30",
      "notification:20",
    ]);
  });

  it("does not re-deliver or lose a row when newer rows arrive mid-scroll", async () => {
    const delivered = await scroll({
      notifications: NONMONOTONIC,
      kinds: ["notification"],
      limit: 2,
      pages: 10,
      afterFirstPage: (notifications) => {
        notifications.rows.push(notifRow({ id: 99, createdAt: daysAgo(0) }));
        notifications.resort();
      },
    });

    expect(delivered).toEqual([
      "notification:10",
      "notification:30",
      "notification:20",
    ]);
    expect(delivered).not.toContain("notification:99");
  });

  it("BITE: orders a timestamp tie numerically, the way the source pages", async () => {
    const sameInstant = daysAgo(1);
    const notifications = makeNotificationDb([
      { id: 9, createdAt: sameInstant },
      { id: 10, createdAt: sameInstant },
    ]);
    const svc = new UnifiedInboxService(
      notifications.db,
      makeAccess(),
      makeMail(),
      makeBroadcasts([]).service,
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 25, kinds: ["notification"], unreadOnly: false },
      makeUser(),
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual([
      "notification:10",
      "notification:9",
    ]);
  });

  it("delivers every item exactly once when the merge order is not monotonic in id", async () => {
    const delivered = await scroll({
      notifications: [
        { id: 3, createdAt: daysAgo(6) },
        { id: 2, createdAt: daysAgo(8) },
        { id: 1, createdAt: daysAgo(12) },
      ],
      broadcasts: [
        { id: 7, sentAt: daysAgo(7) },
        { id: 6, sentAt: daysAgo(9) },
        { id: 5, sentAt: daysAgo(13) },
      ],
      kinds: ["notification", "broadcast"],
      limit: 1,
      pages: 12,
    });

    expect(delivered).toEqual([
      "notification:3",
      "broadcast:7",
      "notification:2",
      "broadcast:6",
      "notification:1",
      "broadcast:5",
    ]);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("leaves a kind's cursor component untouched when that kind delivered nothing", async () => {
    const notifications = makeNotificationDb([]);
    const broadcasts = makeBroadcasts([
      { id: 7, sentAt: daysAgo(3) },
      { id: 6, sentAt: daysAgo(6) },
    ]);
    const svc = new UnifiedInboxService(
      notifications.db,
      makeAccess(),
      makeMail(),
      broadcasts.service,
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 1, kinds: ["notification", "broadcast"], unreadOnly: false },
      makeUser(),
    );

    const state = decodeInboxCursor(result.nextCursor);
    expect(state.n).toBeNull();
    expect(state.nt).toBeNull();
    expect(state.b).toBe(7);
    expect(state.bt).toBe(daysAgo(3).toISOString());
  });
});
