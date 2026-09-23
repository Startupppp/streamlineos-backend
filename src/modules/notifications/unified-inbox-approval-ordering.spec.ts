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
import { decodeInboxCursor, type InboxKind } from "./dto/unified-inbox.schemas";

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
  return {
    listInboxPage: jest.fn().mockResolvedValue({ items: [], accountErrors: [] }),
  } as unknown as MailService;
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
    const result = await svc.list(ORG, UID, { limit, kinds, unreadOnly: false, cursor }, makeUser());
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
      { limit: 2, kinds: ["build_approval"], unreadOnly: false, cursor: undefined },
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

  it("falls back to an id-only bound when a legacy cursor carries no timestamp", async () => {
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

    expect(whereSql).toContain('"project_approvals"."id" < $');
    expect(whereSql).not.toContain('"project_approvals"."created_at" < $');
  });
});
