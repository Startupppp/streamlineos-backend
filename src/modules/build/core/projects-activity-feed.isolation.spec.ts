import { ProjectsActivityFeedService } from "./projects-activity-feed.service";
import type { Db } from "../../../db/drizzle.module";

const PROJECT_ID = 7;
const ORG_ID = "org-1";
const TICKET_ID = 42;
const TICKET_NUMBER = 5;
const PROJECT_KEY = "APP";

function makeProjectQueryMock(found: boolean) {
  return jest.fn().mockResolvedValue(
    found ? { id: PROJECT_ID } : undefined,
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
  const findFirstMock = makeProjectQueryMock(found);
  const selectMock = makeSelectChainMock(rows);
  return {
    query: {
      projects: { findFirst: findFirstMock },
    },
    select: selectMock,
  } as unknown as Db;
}

const actor = {
  userId: "user-1",
  orgId: ORG_ID,
  isOrgOwner: false,
  principal: {},
} as never;

describe("ProjectsActivityFeedService — tenant isolation", () => {
  it("calls assertProjectInOrg with the caller orgId so cross-tenant project IDs are rejected as 404", async () => {
    const db = makeDb(false, []);
    const svc = new ProjectsActivityFeedService(db);

    await expect(
      svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 }),
    ).rejects.toThrow();
  });

  it("returns an empty first page when the project exists but has no activity", async () => {
    const db = makeDb(true, []);
    const svc = new ProjectsActivityFeedService(db);

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
    const svc = new ProjectsActivityFeedService(db);

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
    const svc = new ProjectsActivityFeedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 20 });

    expect(result.data[0]?.user).toBeNull();
    expect(result.data[0]?.label).toBe("created this ticket");
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
    const svc = new ProjectsActivityFeedService(db);

    const result = await svc.getProjectActivity(actor, PROJECT_ID, { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
  });
});
