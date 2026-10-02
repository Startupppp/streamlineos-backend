import { EpicsService } from "./epics.service";
import type { BuildTicketCreationService, ProjectsTicketsUpdateService, ProjectsTicketsDeleteService } from "../core/tickets";
import { decodeTimestampCursor, encodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../../modules/access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual<typeof import("../core/project-crud/project-access")>("../core/project-crud/project-access"),
  assertProjectVisible: jest.fn().mockResolvedValue(undefined),
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertProjectWriteAccess: jest.fn().mockResolvedValue(undefined),
  assertCanManageProject: jest.fn().mockResolvedValue(undefined),
}));

const ORG_ID = "org-epic-cursor";
const ACTOR: CurrentUserContext = {
  userId: "u-owner",
  orgId: ORG_ID,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};
const PROJECT_ID = 31;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record: { queryChunks?: unknown[]; value?: unknown } = value;
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function epicRow(id: number, createdAtMicros: string, title = `Epic ${id}`) {
  return {
    id,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    title,
    description: null,
    type: "EPIC",
    status: "TODO",
    priority: "MEDIUM",
    health: null,
    createdAt: new Date(`${createdAtMicros.slice(0, 19)}Z`),
    updatedAt: new Date(`${createdAtMicros.slice(0, 19)}Z`),
    createdAtMicros,
    version: 1,
  };
}

function makeDb(rows: ReturnType<typeof epicRow>[], captured: { where?: unknown; order?: unknown; limit?: number } = {}) {
  const findMany = jest.fn().mockImplementation((args: { where?: unknown; orderBy?: unknown; limit?: number }) => {
    captured.where = args.where;
    captured.order = args.orderBy;
    captured.limit = args.limit;
    return Promise.resolve(rows);
  });
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID }) },
      tickets: { findMany },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  } as unknown as Db;
}

function epicsService(db: Db): EpicsService {
  return new EpicsService(
    db,
    stubService<BuildTicketCreationService>({}),
    stubService<ProjectsTicketsUpdateService>({}),
    stubService<ProjectsTicketsDeleteService>({}),
    stubService<AccessService>({}),
  );
}

describe("EpicsService — the epic list is a keyset page, not a capped array", () => {
  it("returns a cursor page rather than a bare array, so the caller can page instead of seeing a silent truncation", async () => {
    const service = epicsService(makeDb([epicRow(1, "2026-09-01T10:00:00.000001")]));
    const page = await service.listEpics(ACTOR, PROJECT_ID, {});

    expect(Array.isArray(page)).toBe(false);
    expect(page.data).toHaveLength(1);
    expect(page.pagination).toEqual({ limit: 100, hasMore: false, nextCursor: null });
  });

  it("over-fetches one row and trims it, so hasMore is known without a second count query", async () => {
    const captured: { limit?: number } = {};
    const service = epicsService(
      makeDb(
        [
          epicRow(2, "2026-09-03T10:00:00.000002"),
          epicRow(1, "2026-09-01T10:00:00.000001"),
        ],
        captured,
      ),
    );
    const page = await service.listEpics(ACTOR, PROJECT_ID, { limit: 1 });

    expect(captured.limit).toBe(2);
    expect(page.data.map((row) => row.id)).toEqual([2]);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("encodes the last visible row's createdAt and id, so two epics created in the same microsecond still order totally", async () => {
    const shared = "2026-09-05T09:30:00.123456";
    const service = epicsService(
      makeDb([epicRow(9, shared, "Later id"), epicRow(4, shared, "Earlier id")])
    );
    const page = await service.listEpics(ACTOR, PROJECT_ID, { limit: 1 });

    const decoded = decodeTimestampCursor(page.pagination.nextCursor);
    expect(decoded?.sortValue).toBe(shared);
    expect(decoded?.id).toBe(9);
  });

  it("orders by createdAt then id descending, because a one-column order over a shared timestamp skips rows at the boundary", async () => {
    const captured: { order?: unknown } = {};
    const service = epicsService(makeDb([epicRow(1, "2026-09-01T10:00:00.000001")], captured));
    await service.listEpics(ACTOR, PROJECT_ID, {});

    expect(Array.isArray(captured.order)).toBe(true);
    expect((captured.order as unknown[]).length).toBe(2);
  });

  it("binds the cursor position into the where clause, so the next page starts after the previous one", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, {
      cursor: encodeCursor({ sortValue: "2026-09-05T09:30:00.123456", id: "9" }),
    });

    const bound = sqlValues(captured.where);
    expect(bound).toContain("2026-09-05T09:30:00.123456");
    expect(bound).toContain(9);
  });

  it("ignores a hand-edited cursor rather than binding it, so a tampered position returns the first page", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { cursor: "not-a-cursor" });

    expect(sqlValues(captured.where)).not.toContain("not-a-cursor");
  });

  it("caps the page at PAGE_SIZE_CAP even when the caller asks for more", async () => {
    const captured: { limit?: number } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { limit: 5000 });

    expect(captured.limit).toBe(101);
  });
});

describe("EpicsService — the epic filters are applied in SQL, not by the caller", () => {
  it("binds the search term, so the database narrows the page instead of the client filtering one page of it", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { q: "checkout" });

    expect(sqlValues(captured.where)).toContain("%checkout%");
  });

  it("escapes a wildcard in the search term, so a literal % cannot widen the match", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { q: "50%_off" });

    expect(sqlValues(captured.where)).toContain("%50\\%\\_off%");
  });

  it("binds status and health, the two stored columns the page filters on", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { status: "IN_PROGRESS", health: "at_risk" });

    const bound = sqlValues(captured.where);
    expect(bound).toContain("IN_PROGRESS");
    expect(bound).toContain("at_risk");
  });

  it("resolves an owner filter through the tenant's own memberships, so a user id from another org selects nothing", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, { ownerId: "user-77" });

    const bound = sqlValues(captured.where);
    expect(bound).toContain("user-77");
    expect(bound).toContain(ORG_ID);
  });

  it("binds no filter value when the caller sends none, so the predicates are not always on", async () => {
    const captured: { where?: unknown } = {};
    const service = epicsService(makeDb([], captured));
    await service.listEpics(ACTOR, PROJECT_ID, {});

    const bound = sqlValues(captured.where);
    expect(bound).not.toContain("%checkout%");
    expect(bound).not.toContain("user-77");
    expect(bound).not.toContain("at_risk");
  });
});
