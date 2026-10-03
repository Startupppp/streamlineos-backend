jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { UnifiedInboxService } from "./unified-inbox.service";
import { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  parseInboxCursor,
  type InboxKind,
  type InboxSourcePosition,
} from "./dto/unified-inbox.schemas";
import { fetchNotificationItems } from "./unified-inbox-sources";

const ORG = "org-1";
const UID = "user-1";
const MEMBERSHIP = 1;
const DAY_MS = 86_400_000;
const ORIGIN = Date.now();

function daysAgo(days: number): Date {
  return new Date(ORIGIN - days * DAY_MS);
}

type ApprovalSeed = { id: number; createdAt: Date };

const NONMONOTONIC: ApprovalSeed[] = [
  { id: 10, createdAt: daysAgo(2) },
  { id: 30, createdAt: daysAgo(4) },
  { id: 20, createdAt: daysAgo(10) },
];

function approvalRows(seeds: ApprovalSeed[]): TableRows {
  const ordered = [...seeds].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    return byTime !== 0 ? byTime : b.id - a.id;
  });
  return {
    project_approvals: ordered.map((seed) => ({
      id: seed.id,
      org_id: ORG,
      project_id: 7,
      title: `approval ${String(seed.id)}`,
      status: "pending",
      entity_type: "task",
      entity_id: seed.id,
      due_at: null,
      created_at: seed.createdAt,
      deleted_at: null,
      approver_membership_id: MEMBERSHIP,
    })),
  };
}

function makeApprovalDb(seeds: ApprovalSeed[]): Db {
  return makeFakeDb(approvalRows(seeds)) as unknown as Db;
}

function makeAccess(): AccessService {
  return {
    holds: jest.fn().mockResolvedValue(true),
  } as unknown as AccessService;
}

function makeMail(): MailService {
  return {} as unknown as MailService;
}

function makeBroadcasts(): BroadcastsService {
  return {
    listInboxPage: jest.fn().mockResolvedValue([]),
  } as unknown as BroadcastsService;
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

function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import("../attention/approval-adapter.registry").ApprovalAdapterRegistry;
}

async function scrollApprovals(seeds: ApprovalSeed[], limit: number, pages: number): Promise<string[]> {
  const db = makeApprovalDb(seeds);
  const svc = new UnifiedInboxService(
    db,
    makeAccess(),
    makeMail(),
    makeBroadcasts(),
    new BuildApprovalsInboxService(db),
    makeRegistry(),
  );
  const kinds: InboxKind[] = ["build_approval"];
  const delivered: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pages; page++) {
    const result = await svc.list(ORG, UID, { limit, kinds, unreadOnly: false, eventKeys: undefined, cursor }, makeUser());
    for (const item of result.items) delivered.push(item.dedupKey);
    if (!result.hasMore || result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  return delivered;
}

describe("unified inbox — build approvals page on the key the merge sorts by", () => {
  it("BITE: delivers every approval across a complete scroll of an id-nonmonotonic source", async () => {
    const delivered = await scrollApprovals(NONMONOTONIC, 2, 5);

    expect(delivered).toEqual(["approval:build:10", "approval:build:30", "approval:build:20"]);
    expect(new Set(delivered).size).toBe(3);
  });

  it("BITE: never delivers the same approval twice while the cursor walks the source", async () => {
    const delivered = await scrollApprovals(NONMONOTONIC, 2, 5);

    expect(delivered.length).toBe(new Set(delivered).size);
  });

  it("advances the approval cursor to the position of the LAST row delivered", async () => {
    const db = makeApprovalDb(NONMONOTONIC);
    const svc = new UnifiedInboxService(
      db,
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      new BuildApprovalsInboxService(db),
      makeRegistry(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined, cursor: undefined },
      makeUser(),
    );

    expect(result.items.map((item) => item.dedupKey)).toEqual(["approval:build:10", "approval:build:30"]);
    const state = decodeInboxCursor(result.nextCursor);
    expect(state.a).toBe(30);
    expect(state.at).toBe(daysAgo(4).toISOString());
  });

  it("orders the approval source by the same (created_at, id) key its cursor bounds", async () => {
    const dialect = new PgDialect();
    let orderBySql = "";
    let whereSql = "";
    const chain: Record<string, jest.Mock> = {};
    chain["from"] = jest.fn(() => chain);
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

    await new BuildApprovalsInboxService(db).getInboxPage(
      ORG,
      UID,
      MEMBERSHIP,
      5,
      30,
      daysAgo(4).toISOString(),
    );

    const timeRank = orderBySql.indexOf('"project_approvals"."created_at" desc');
    const idRank = orderBySql.indexOf('"project_approvals"."id" desc');
    expect(timeRank).toBeGreaterThanOrEqual(0);
    expect(idRank).toBeGreaterThan(timeRank);
    expect(whereSql).toContain('"project_approvals"."created_at" < $');
    expect(whereSql).toContain('"project_approvals"."created_at" = $');
    expect(whereSql).toContain('"project_approvals"."id" < $');
  });

  it("discards a cursor that carries an id but no timestamp, returning the first page", async () => {
    const dialect = new PgDialect();
    let whereSql = "";
    const chain: Record<string, jest.Mock> = {};
    chain["from"] = jest.fn(() => chain);
    chain["where"] = jest.fn((predicate: SQL) => {
      whereSql = dialect.sqlToQuery(predicate).sql;
      return chain;
    });
    chain["orderBy"] = jest.fn(() => chain);
    chain["limit"] = jest.fn(() => Promise.resolve([]));
    const db = { select: jest.fn(() => chain) } as unknown as Db;

    await new BuildApprovalsInboxService(db).getInboxPage(ORG, UID, MEMBERSHIP, 5, 30, null);

    expect(whereSql).not.toContain('"project_approvals"."id" < $');
    expect(whereSql).not.toContain('"project_approvals"."created_at" < $');
  });
});

function notifRows(seeds: ApprovalSeed[]): TableRows {
  const ordered = [...seeds].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    return byTime !== 0 ? byTime : b.id - a.id;
  });
  return {
    notifications: ordered.map((seed) => ({
      id: seed.id,
      org_id: ORG,
      membership_id: MEMBERSHIP,
      type: "info",
      priority: "normal",
      category: "system",
      source_module: "system",
      event_key: null,
      title: `notification ${String(seed.id)}`,
      message: "",
      link: null,
      is_read: false,
      pinned: false,
      created_at: seed.createdAt,
      deleted_at: null,
      archived_at: null,
      snoozed_until: null,
      actor_user_id: null,
    })),
    users: [],
  };
}

async function scrollNotifications(seeds: ApprovalSeed[], limit: number, pages: number): Promise<string[]> {
  const db = makeFakeDb(notifRows(seeds)) as unknown as Db;
  const delivered: string[] = [];
  let cursor: InboxSourcePosition | null = null;

  for (let page = 0; page < pages; page++) {
    const items = await fetchNotificationItems(db, ORG, MEMBERSHIP, limit, cursor, false);
    for (const item of items) delivered.push(item.dedupKey);
    if (items.length < limit) break;
    const last = items[items.length - 1];
    if (!last) break;
    cursor = { id: last.id, t: last.timestamp };
  }

  return delivered;
}

describe("67.69 — cursor boundary: malformed, invalid timestamp, incomplete pair, source error", () => {
  function makeSvc(seeds: ApprovalSeed[]): UnifiedInboxService {
    const db = makeApprovalDb(seeds);
    return new UnifiedInboxService(
      db,
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      new BuildApprovalsInboxService(db),
      makeRegistry(),
    );
  }

  it("parseInboxCursor returns ok:false with an actionable reason when the cursor is not valid JSON", () => {
    const malformed = Buffer.from("not-valid-json", "utf8").toString("base64url");
    const result = parseInboxCursor(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/json/i);
      expect(result.reason).toContain("resubmit without a cursor");
    }
  });

  it("parseInboxCursor returns ok:false with an actionable reason when the cursor is valid base64 of non-object JSON", () => {
    const notAnObject = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    const result = parseInboxCursor(notAnObject);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("resubmit without a cursor");
    }
  });

  it("approval source shows a cursor error and delivers no items when the cursor has an approval id but no timestamp", async () => {
    const incompleteCursor = encodeInboxCursor({
      n: null, nt: null, b: null, bt: null, m: null,
      a: 30, at: null, ap: {},
    });

    const svc = makeSvc(NONMONOTONIC);
    const result = await svc.list(
      ORG, UID,
      { limit: 5, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined, cursor: incompleteCursor },
      makeUser(),
    );

    expect(result.items).toHaveLength(0);
    const approvalSource = result.sources.find((s) => s.kind === "build_approval");
    expect(approvalSource?.included).toBe(true);
    expect(approvalSource?.available).toBe(false);
    expect(approvalSource?.error).toContain("timestamp");
    expect(approvalSource?.error).toContain("resubmit without a cursor");
  });

  it("approval source shows a cursor error and delivers no items when the cursor has an invalid timestamp string", async () => {
    const invalidTsCursor = encodeInboxCursor({
      n: null, nt: null, b: null, bt: null, m: null,
      a: 30, at: "not-a-valid-timestamp", ap: {},
    });

    const svc = makeSvc(NONMONOTONIC);
    const result = await svc.list(
      ORG, UID,
      { limit: 5, kinds: ["build_approval"], unreadOnly: false, eventKeys: undefined, cursor: invalidTsCursor },
      makeUser(),
    );

    expect(result.items).toHaveLength(0);
    const approvalSource = result.sources.find((s) => s.kind === "build_approval");
    expect(approvalSource?.included).toBe(true);
    expect(approvalSource?.available).toBe(false);
    expect(approvalSource?.error).toContain("invalid timestamp");
    expect(approvalSource?.error).toContain("resubmit without a cursor");
  });

  it("all sources show a cursor error when the cursor string is malformed JSON and no items are delivered", async () => {
    const malformed = Buffer.from("not-valid-json", "utf8").toString("base64url");
    const svc = makeSvc(NONMONOTONIC);

    const result = await svc.list(
      ORG, UID,
      { limit: 5, kinds: ["build_approval", "notification"], unreadOnly: false, eventKeys: undefined, cursor: malformed },
      makeUser(),
    );

    expect(result.items).toHaveLength(0);
    expect(result.degraded).toBe(true);
    const included = result.sources.filter((s) => s.included);
    expect(included.length).toBeGreaterThan(0);
    included.forEach((s) => {
      expect(s.available).toBe(false);
      expect(s.error).toContain("resubmit without a cursor");
    });
  });
});

describe("unified inbox — notification keyset on the same (created_at, id) key", () => {
  it("BITE: delivers every notification across a complete scroll of an id-nonmonotonic source", async () => {
    const delivered = await scrollNotifications(NONMONOTONIC, 2, 5);

    expect(delivered).toEqual(["notification:10", "notification:30", "notification:20"]);
    expect(new Set(delivered).size).toBe(3);
  });

  it("BITE: never delivers the same notification twice while the cursor walks the source", async () => {
    const delivered = await scrollNotifications(NONMONOTONIC, 2, 5);

    expect(delivered.length).toBe(new Set(delivered).size);
  });

  it("discards a notification cursor that carries an id but no timestamp, returning the first page", async () => {
    const dialect = new PgDialect();
    let whereSql = "";
    const chain: Record<string, jest.Mock> = {};
    chain["from"] = jest.fn(() => chain);
    chain["leftJoin"] = jest.fn(() => chain);
    chain["where"] = jest.fn((predicate: SQL) => {
      whereSql = dialect.sqlToQuery(predicate).sql;
      return chain;
    });
    chain["orderBy"] = jest.fn(() => chain);
    chain["limit"] = jest.fn(() => Promise.resolve([]));
    const db = { select: jest.fn(() => chain) } as unknown as Db;

    await fetchNotificationItems(db, ORG, MEMBERSHIP, 5, { id: 30, t: null }, false);

    expect(whereSql).not.toContain('"notifications"."id" < $');
    expect(whereSql).not.toContain('"notifications"."created_at" = $');
  });
});
