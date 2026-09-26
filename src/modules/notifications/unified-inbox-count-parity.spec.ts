jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import {
  ApprovalAdapterRegistry,
  type ApprovalSourceAdapter,
} from "../attention/approval-adapter.registry";
import { UnifiedInboxService } from "./unified-inbox.service";
import { APPROVAL_COUNT_SCAN_LIMIT } from "./unified-inbox-sources";
import { makeBroadcasts, makeUser, ORG, UID } from "./approval-cursor.spec-fixtures";
import type { BuildApprovalInboxItem } from "./dto/unified-inbox.schemas";

const dialect = new PgDialect();

type Captured = { count?: SQL; list?: SQL };

type DbOptions = {
  lastReadId?: number;
  unreadCount?: number;
  notifRows?: Record<string, unknown>[];
};

function makeDb(options: DbOptions, captured: Captured): Db {
  return {
    select: (projection: Record<string, unknown>) => {
      const keys = Object.keys(projection);
      if (keys.includes("lastReadId")) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve(
                options.lastReadId === undefined
                  ? []
                  : [{ lastReadId: options.lastReadId }],
              ),
          }),
        };
      }
      if (keys.includes("cnt")) {
        return {
          from: () => ({
            where: (where: SQL) => {
              captured.count = where;
              return Promise.resolve([{ cnt: options.unreadCount ?? 0 }]);
            },
          }),
        };
      }
      return {
        from: () => ({
          leftJoin: () => ({
            where: (where: SQL) => {
              captured.list = where;
              return {
                orderBy: () => ({
                  limit: () => Promise.resolve(options.notifRows ?? []),
                }),
              };
            },
          }),
        }),
      };
    },
  } as unknown as Db;
}

function makeAccess(granted: ReadonlySet<string>): AccessService {
  return {
    holds: jest.fn((_user: unknown, key: string) =>
      Promise.resolve(granted.has(key)),
    ),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
}

function makeMail(): MailService {
  return {
    listMessages: jest
      .fn()
      .mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
    areAllAccountsFresh: jest.fn().mockResolvedValue(true),
  } as unknown as MailService;
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockResolvedValue([]),
  } as unknown as BuildApprovalsInboxService;
}

function approvalItem(
  id: number,
  approvalKind: string,
  objectType: string,
  objectId: string,
): BuildApprovalInboxItem {
  return {
    kind: "build_approval",
    id,
    approvalKind,
    status: "pending",
    projectId: null,
    ticketId: null,
    dueAt: null,
    objectType,
    objectId,
    dedupKey: `approval:${approvalKind}:${String(id)}`,
    sourceModule: "hr",
    subject: `${approvalKind} request`,
    timestamp: new Date("2026-09-20T00:00:00.000Z").toISOString(),
    isRead: false,
    deepLink: "/hr/approvals",
    actor: null,
  };
}

function stubAdapter(
  module: string,
  kindLabel: string,
  permission: string,
  items: BuildApprovalInboxItem[],
): ApprovalSourceAdapter {
  return {
    module,
    kindLabel,
    permission,
    supportsAfterCursor: true,
    fetch: () => Promise.resolve(items),
  };
}

function notifRow(id: number, isRead: boolean) {
  return {
    id: BigInt(id),
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sourceModule: "system",
    eventKey: null,
    title: `Notif ${String(id)}`,
    message: `Body ${String(id)}`,
    link: null,
    isRead,
    pinned: false,
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
    actorUserId: null,
    actorId: null,
    actorName: null,
    actorImage: null,
  };
}

function makeService(
  db: Db,
  registry: ApprovalAdapterRegistry,
  granted: ReadonlySet<string> = new Set(),
): UnifiedInboxService {
  return new UnifiedInboxService(
    db,
    makeAccess(granted),
    makeMail(),
    makeBroadcasts(),
    makeBuildApprovals(),
    registry,
  );
}

describe("D8 — mark-all-read writes a watermark, so the unified badge must honour it", () => {
  it("excludes notifications at or below the mark-all-read watermark from the unified unread count", async () => {
    const captured: Captured = {};
    const svc = makeService(
      makeDb({ lastReadId: 42 }, captured),
      new ApprovalAdapterRegistry(),
    );

    await svc.unifiedUnreadCount(ORG, UID, makeUser());

    const compiled = dialect.sqlToQuery(captured.count as SQL);
    expect(compiled.sql).toMatch(/"id" > \$/);
    expect(compiled.params).toContain(42);
  });

  it("CONTROL: with no watermark row the unified unread count adds no id predicate at all", async () => {
    const captured: Captured = {};
    const svc = makeService(makeDb({}, captured), new ApprovalAdapterRegistry());

    await svc.unifiedUnreadCount(ORG, UID, makeUser());

    const compiled = dialect.sqlToQuery(captured.count as SQL);
    expect(compiled.sql).not.toMatch(/"id" > \$/);
  });

  it("reports a notification below the watermark as read in the unified list, so badge and list agree after mark-all-read", async () => {
    const captured: Captured = {};
    const svc = makeService(
      makeDb({ lastReadId: 42, notifRows: [notifRow(7, false)] }, captured),
      new ApprovalAdapterRegistry(),
    );

    const page = await svc.list(
      ORG,
      UID,
      { limit: 25, kinds: ["notification"], unreadOnly: false, eventKeys: undefined },
      makeUser(),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0].isRead).toBe(true);
  });

  it("CONTROL: a notification above the watermark is still reported unread in the unified list", async () => {
    const captured: Captured = {};
    const svc = makeService(
      makeDb({ lastReadId: 42, notifRows: [notifRow(99, false)] }, captured),
      new ApprovalAdapterRegistry(),
    );

    const page = await svc.list(
      ORG,
      UID,
      { limit: 25, kinds: ["notification"], unreadOnly: false, eventKeys: undefined },
      makeUser(),
    );

    expect(page.items[0].isRead).toBe(false);
  });
});

describe("D7 — the unified count must apply the same retention window the list applies", () => {
  it("bounds the unified unread count by created_at at both ends, so a range-partitioned scan can prune", async () => {
    const captured: Captured = {};
    const svc = makeService(makeDb({}, captured), new ApprovalAdapterRegistry());

    await svc.unifiedUnreadCount(ORG, UID, makeUser());

    const compiled = dialect.sqlToQuery(captured.count as SQL);
    expect(compiled.sql).toMatch(/"created_at" >= \$/);
    expect(compiled.sql).toMatch(/"created_at" < \$/);
  });

  it("CONTROL: the list path this count must agree with already bounds created_at at both ends", async () => {
    const captured: Captured = {};
    const svc = makeService(makeDb({}, captured), new ApprovalAdapterRegistry());

    await svc.list(
      ORG,
      UID,
      { limit: 25, kinds: ["notification"], unreadOnly: false, eventKeys: undefined },
      makeUser(),
    );

    const compiled = dialect.sqlToQuery(captured.list as SQL);
    expect(compiled.sql).toMatch(/"created_at" >= \$/);
    expect(compiled.sql).toMatch(/"created_at" < \$/);
  });
});

describe("D13 — a capped approval scan must declare itself inexact, exactly as mail does", () => {
  it("reports approvalExact false when an adapter filled the approval count scan page", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter(
        "hr",
        "workflow",
        "hr:workflows:approve",
        Array.from({ length: APPROVAL_COUNT_SCAN_LIMIT }, (_, i) =>
          approvalItem(i + 1, "workflow", "leave_request", String(i + 1)),
        ),
      ),
    );
    const svc = makeService(
      makeDb({}, {}),
      registry,
      new Set(["hr:workflows:approve"]),
    );

    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(APPROVAL_COUNT_SCAN_LIMIT);
    expect(count.approvalExact).toBe(false);
  });

  it("CONTROL: reports approvalExact true when no adapter filled its page, so the figure is exact", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter("hr", "workflow", "hr:workflows:approve", [
        approvalItem(1, "workflow", "leave_request", "1"),
      ]),
    );
    const svc = makeService(
      makeDb({}, {}),
      registry,
      new Set(["hr:workflows:approve"]),
    );

    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(1);
    expect(count.approvalExact).toBe(true);
  });
});

describe("D9 — one leave request must not count once per adapter that can see it", () => {
  it("counts a single leave request once even though the workflow adapter and the leave adapter both surface it", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter("hr", "workflow", "hr:workflows:approve", [
        approvalItem(900, "workflow", "leave_request", "77"),
      ]),
    );
    registry.register(
      stubAdapter("hr", "leave", "hr:leaves:approve", [
        approvalItem(77, "leave", "leave_request", "77"),
      ]),
    );
    const svc = makeService(
      makeDb({}, {}),
      registry,
      new Set(["hr:workflows:approve", "hr:leaves:approve"]),
    );

    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(1);
  });

  it("CONTROL: two different leave requests still count twice", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter("hr", "workflow", "hr:workflows:approve", [
        approvalItem(900, "workflow", "leave_request", "77"),
      ]),
    );
    registry.register(
      stubAdapter("hr", "leave", "hr:leaves:approve", [
        approvalItem(78, "leave", "leave_request", "78"),
      ]),
    );
    const svc = makeService(
      makeDb({}, {}),
      registry,
      new Set(["hr:workflows:approve", "hr:leaves:approve"]),
    );

    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(2);
  });

  it("delivers that same leave request as one row in the unified list, so the badge and the list agree", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter("hr", "workflow", "hr:workflows:approve", [
        approvalItem(900, "workflow", "leave_request", "77"),
      ]),
    );
    registry.register(
      stubAdapter("hr", "leave", "hr:leaves:approve", [
        approvalItem(77, "leave", "leave_request", "77"),
      ]),
    );
    const svc = makeService(
      makeDb({}, {}),
      registry,
      new Set(["hr:workflows:approve", "hr:leaves:approve"]),
    );

    const page = await svc.list(
      ORG,
      UID,
      { limit: 25, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined },
      makeUser(),
    );

    expect(page.items).toHaveLength(1);
  });
});
