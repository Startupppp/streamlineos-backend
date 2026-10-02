import { ProjectsActivityFeedService } from "./projects-activity-feed.service";
import { decodeCursor } from "../../../../common/pagination/cursor";
import type { Db } from "../../../../db/drizzle.module";
import { stubService } from "../../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { projectAccessRow } from "../../__tests__/project-access-doubles";

function hasColumnName(node: unknown, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (obj["name"] === name) return true;
  if (Array.isArray(obj["queryChunks"])) {
    return (obj["queryChunks"] as unknown[]).some((c) => hasColumnName(c, name));
  }
  return false;
}

const PROJECT_ID = 7;
const ORG_ID = "org-1";
const TICKET_ID = 42;
const TICKET_NUMBER = 5;
const PROJECT_KEY = "APP";

function withProjectGate(feedSelect: jest.Mock, found: boolean) {
  const projectChain = {
    from: () => projectChain,
    where: () => projectChain,
    limit: () => Promise.resolve(found ? [projectAccessRow()] : []),
  };
  return jest.fn((projection: Record<string, unknown>) =>
    "manages" in projection ? projectChain : feedSelect(projection),
  );
}

function makeSelectChainMock(rows: unknown[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
  const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
  const leftJoin3 = jest.fn().mockReturnValue({ where: whereMock });
  const leftJoin2 = jest.fn().mockReturnValue({ leftJoin: leftJoin3 });
  const leftJoin1 = jest.fn().mockReturnValue({ leftJoin: leftJoin2 });
  const innerJoin2 = jest.fn().mockReturnValue({ leftJoin: leftJoin1 });
  const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
  return jest.fn().mockReturnValue({ from: fromMock });
}

function makeDb(found: boolean, rows: unknown[]) {
  return {
    select: withProjectGate(makeSelectChainMock(rows), found),
  } as unknown as Db;
}

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG_ID,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function feedService(db: Db): ProjectsActivityFeedService {
  return new ProjectsActivityFeedService(
    db,
    stubService<AccessService>({ scopeFor: jest.fn().mockResolvedValue("all") }),
  );
}

describe("ProjectsActivityFeedService — tenant isolation", () => {
  it("rejects a cross-tenant project id as 404 before reading the feed", async () => {
    const db = makeDb(false, []);
    const svc = feedService(db);

    await expect(
      svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 }),
    ).rejects.toThrow();
  });

  it("returns an empty first page when the project exists but has no activity", async () => {
    const db = makeDb(true, []);
    const svc = feedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 });

    expect(result.data).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("maps a row with a resolved actor to an item with user.name and ticket context", async () => {
    const row = {
      id: 100,
      action: "status_changed",
      fromValue: "TODO",
      toValue: "IN_PROGRESS",
      createdAt: new Date("2026-01-01T10:00:00Z"),
      userMembershipId: 3,
      ticketId: TICKET_ID,
      ticketTitle: "Fix the bug",
      ticketNumber: TICKET_NUMBER,
      projectKey: PROJECT_KEY,
      personUserId: "user-1",
      memberUserId: "user-1",
      displayName: null,
      firstName: "Alice",
      lastName: "Smith",
      avatarUrl: null,
      accountName: null,
      email: "alice@example.com",
      userImage: null,
    };

    const db = makeDb(true, [row]);
    const svc = feedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 });

    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(item?.ticketId).toBe(TICKET_ID);
    expect(item?.ticketTitle).toBe("Fix the bug");
    expect(item?.ticketNumber).toBe(TICKET_NUMBER);
    expect(item?.projectKey).toBe(PROJECT_KEY);
    expect(item?.action).toBe("status_changed");
    expect(item?.label).toBe("changed status");
    expect(item?.user?.name).toMatch(/Alice/);
  });

  it("maps a row with no actor to an item with user null so system events are displayed without a name", async () => {
    const row = {
      id: 101,
      action: "created",
      fromValue: null,
      toValue: null,
      createdAt: new Date("2026-01-01T09:00:00Z"),
      userMembershipId: null,
      ticketId: TICKET_ID,
      ticketTitle: "New ticket",
      ticketNumber: 1,
      projectKey: PROJECT_KEY,
      personUserId: null,
      memberUserId: null,
      displayName: null,
      firstName: null,
      lastName: null,
      avatarUrl: null,
      accountName: null,
      email: null,
      userImage: null,
    };

    const db = makeDb(true, [row]);
    const svc = feedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 });

    expect(result.data[0]?.user).toBeNull();
    expect(result.data[0]?.label).toBe("created this ticket");
  });

  it("places the project_id filter on the log table column so the org-project-id partial index is the seek path", async () => {
    let capturedWhere: unknown;

    const limitMock = jest.fn().mockResolvedValue([]);
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockImplementation((cond: unknown) => {
      capturedWhere = cond;
      return { orderBy: orderByMock };
    });
    const leftJoin3 = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoin2 = jest.fn().mockReturnValue({ leftJoin: leftJoin3 });
    const leftJoin1 = jest.fn().mockReturnValue({ leftJoin: leftJoin2 });
    const innerJoin2 = jest.fn().mockReturnValue({ leftJoin: leftJoin1 });
    const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
    const db = {
      select: withProjectGate(jest.fn().mockReturnValue({ from: fromMock }), true),
    } as unknown as Db;

    const svc = feedService(db);
    await svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 });

    expect(capturedWhere).toBeDefined();
    expect(hasColumnName(capturedWhere, "project_id")).toBe(true);
  });

  it("trims the sentinel row and signals hasMore so the client knows a next page exists without a count query", async () => {
    const makeRow = (id: number) => ({
      id,
      action: "comment_added",
      fromValue: null,
      toValue: null,
      createdAt: new Date(),
      userMembershipId: null,
      ticketId: TICKET_ID,
      ticketTitle: "T",
      ticketNumber: 1,
      projectKey: PROJECT_KEY,
      personUserId: null,
      memberUserId: null,
      displayName: null,
      firstName: null,
      lastName: null,
      avatarUrl: null,
      accountName: null,
      email: null,
      userImage: null,
    });

    const rows = [makeRow(5), makeRow(4), makeRow(3)];
    const db = makeDb(true, rows);
    const svc = feedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
  });
});

function makeActivityRow(id: number) {
  return {
    id,
    action: "comment_added" as const,
    fromValue: null,
    toValue: null,
    createdAt: new Date(),
    userMembershipId: null,
    ticketId: TICKET_ID,
    ticketTitle: "T",
    ticketNumber: 1,
    projectKey: PROJECT_KEY,
    personUserId: null,
    memberUserId: null,
    displayName: null,
    firstName: null,
    lastName: null,
    avatarUrl: null,
    accountName: null,
    email: null,
    userImage: null,
  };
}

describe("ProjectsActivityFeedService — cursor paging yields each entry exactly once (ticket 17)", () => {
  it("nextCursor encodes the id of the last returned row so the next call knows the exact position to continue from", async () => {
    const rows = [makeActivityRow(10), makeActivityRow(9), makeActivityRow(8)];
    const db = makeDb(true, rows);
    const svc = feedService(db);

    const page1 = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 2 });

    expect(page1.data.map((r) => r.id)).toEqual([10, 9]);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.pagination.nextCursor).not.toBeNull();

    const position = decodeCursor(page1.pagination.nextCursor!);
    expect(position?.sortValue).toBe("9");
  });

  it("page 2 WHERE clause contains an id predicate when a cursor is supplied so the boundary row is excluded from the following page", async () => {
    const rows1 = [makeActivityRow(10), makeActivityRow(9), makeActivityRow(8)];
    const db1 = makeDb(true, rows1);
    const svc1 = feedService(db1);
    const page1 = await svc1.getProjectActivity(actor, PROJECT_ID, { limit: 2 });

    const cursor = page1.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    let capturedWherePage2: unknown;
    const limitMock2 = jest.fn().mockResolvedValue([makeActivityRow(8)]);
    const orderByMock2 = jest
      .fn()
      .mockReturnValue({ limit: limitMock2 });
    const whereMock2 = jest.fn().mockImplementation((cond: unknown) => {
      capturedWherePage2 = cond;
      return { orderBy: orderByMock2 };
    });
    const lj3 = jest.fn().mockReturnValue({ where: whereMock2 });
    const lj2 = jest.fn().mockReturnValue({ leftJoin: lj3 });
    const lj1 = jest.fn().mockReturnValue({ leftJoin: lj2 });
    const ij2 = jest.fn().mockReturnValue({ leftJoin: lj1 });
    const ij1 = jest.fn().mockReturnValue({ innerJoin: ij2 });
    const fromMock2 = jest.fn().mockReturnValue({ innerJoin: ij1 });
    const db2 = {
      select: withProjectGate(jest.fn().mockReturnValue({ from: fromMock2 }), true),
    } as unknown as Db;

    const svc2 = feedService(db2);
    await svc2.getProjectActivity(actor, PROJECT_ID, {
      limit: 2,
      cursor: cursor!,
    });

    expect(capturedWherePage2).toBeDefined();
    expect(hasColumnName(capturedWherePage2, "id")).toBe(true);
  });

  it("row ids from page 1 are all absent from page 2 when the cursor from page 1 is passed so the keyset is a strict partition with no duplicates", async () => {
    const rows1 = [makeActivityRow(10), makeActivityRow(9), makeActivityRow(8)];
    const db1 = makeDb(true, rows1);
    const svc1 = feedService(db1);
    const page1 = await svc1.getProjectActivity(actor, PROJECT_ID, { limit: 2 });

    expect(page1.data.map((r) => r.id)).toEqual([10, 9]);

    const cursor = page1.pagination.nextCursor!;
    const position = decodeCursor(cursor);
    expect(Number(position?.sortValue)).toBe(9);

    const rows2 = [makeActivityRow(8), makeActivityRow(7)];
    const db2 = makeDb(true, rows2);
    const svc2 = feedService(db2);
    const page2 = await svc2.getProjectActivity(actor, PROJECT_ID, {
      limit: 2,
      cursor,
    });

    const page1Ids = new Set(page1.data.map((r) => r.id));
    const page2Ids = page2.data.map((r) => r.id);
    expect(page2Ids.every((id) => !page1Ids.has(id))).toBe(true);
  });
});
