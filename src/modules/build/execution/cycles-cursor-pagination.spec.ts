import { CyclesService } from "./cycles.service";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../../modules/access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG_ID = "org-cursor-99";
const ACTOR: CurrentUserContext = {
  userId: "u-owner",
  orgId: ORG_ID,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};
const PROJECT_ID = 12;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeBaseRow(id: number, startDate: string, name = `Cycle ${id}`) {
  return {
    id,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    name,
    description: null,
    goal: null,
    capacity: null,
    startDate,
    endDate: "2026-12-31",
    status: "draft" as const,
    version: 1,
    createdBy: "user-1",
    createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-01"),
  };
}

function makeDb(mainRows: ReturnType<typeof makeBaseRow>[], capturedConds: unknown[] = []) {
  let selectCallCount = 0;
  const mainChain = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((cond: unknown) => {
        capturedConds.push(cond);
        return {
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(mainRows),
          }),
        };
      }),
    }),
  };
  const statsChain = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        groupBy: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  return {
    select: jest.fn().mockImplementation(() => {
      selectCallCount++;
      return selectCallCount === 1 ? mainChain : statsChain;
    }),
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID }),
      },
    },
  } as unknown as Db;
}

describe("CyclesService — cursor pagination", () => {
  it("returns hasMore=false and no cursor when the row count does not exceed the limit", async () => {
    const row = makeBaseRow(1, "2026-10-01");
    const db = makeDb([row]);
    const service = new CyclesService(db, stubService<AccessService>({}));
    const page = await service.listCycles(ACTOR, PROJECT_ID, { limit: 10 });

    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("returns hasMore=true and a cursor when the row count exceeds the limit so the caller knows there is a next page", async () => {
    const row1 = makeBaseRow(1, "2026-10-01");
    const row2 = makeBaseRow(2, "2026-10-15");
    const db = makeDb([row1, row2]);
    const service = new CyclesService(db, stubService<AccessService>({}));
    const page = await service.listCycles(ACTOR, PROJECT_ID, { limit: 1 });

    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("cursor encodes the last visible row's startDate and id so the tiebreak survives a shared sort value at the page boundary", async () => {
    const rowA = makeBaseRow(3, "2026-11-01", "Alpha");
    const rowB = makeBaseRow(7, "2026-11-01", "Beta");
    const db = makeDb([rowA, rowB]);
    const service = new CyclesService(db, stubService<AccessService>({}));
    const page = await service.listCycles(ACTOR, PROJECT_ID, { limit: 1 });

    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    const decoded = decodeCursor(page.pagination.nextCursor ?? undefined);
    expect(decoded?.sortValue).toBe("2026-11-01");
    expect(decoded?.id).toBe("3");
  });

  it("two rows that share the same startDate each occupy their own cursor position via the id tiebreak, so neither is skipped nor repeated at the page boundary", async () => {
    const rowX = makeBaseRow(10, "2026-11-01", "First");
    const rowY = makeBaseRow(11, "2026-11-01", "Second");
    const rowZ = makeBaseRow(12, "2026-11-15", "Third");
    const db = makeDb([rowX, rowY, rowZ]);
    const service = new CyclesService(db, stubService<AccessService>({}));
    const page = await service.listCycles(ACTOR, PROJECT_ID, { limit: 2 });

    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(true);
    const decoded = decodeCursor(page.pagination.nextCursor ?? undefined);
    expect(decoded?.sortValue).toBe("2026-11-01");
    expect(decoded?.id).toBe("11");
  });

  it("returns an empty cursor page instead of a bare array when there are no matching cycles", async () => {
    const db = makeDb([]);
    const service = new CyclesService(db, stubService<AccessService>({}));
    const page = await service.listCycles(ACTOR, PROJECT_ID, {});

    expect(Array.isArray(page)).toBe(false);
    expect(page.data).toEqual([]);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });
});

describe("CyclesService — server-side filters applied to SQL", () => {
  it("q filter injects the search term into the where clause so the DB, not the client, narrows the result set", async () => {
    const capturedConds: unknown[] = [];
    const row = makeBaseRow(1, "2026-10-01", "Sprint Alpha");
    const db = makeDb([row], capturedConds);
    const service = new CyclesService(db, stubService<AccessService>({}));
    await service.listCycles(ACTOR, PROJECT_ID, { q: "Alpha" });

    const values = sqlValues(capturedConds);
    expect(values.some((v) => typeof v === "string" && v.includes("Alpha"))).toBe(true);
  });

  it("from filter injects the boundary date into the where clause so cycles ending before the window are excluded by the DB", async () => {
    const capturedConds: unknown[] = [];
    const row = makeBaseRow(1, "2026-10-01");
    const db = makeDb([row], capturedConds);
    const service = new CyclesService(db, stubService<AccessService>({}));
    await service.listCycles(ACTOR, PROJECT_ID, { from: "2026-09-15" });

    const values = sqlValues(capturedConds);
    expect(values).toContain("2026-09-15");
  });

  it("to filter injects the boundary date into the where clause so cycles starting after the window are excluded by the DB", async () => {
    const capturedConds: unknown[] = [];
    const row = makeBaseRow(1, "2026-10-01");
    const db = makeDb([row], capturedConds);
    const service = new CyclesService(db, stubService<AccessService>({}));
    await service.listCycles(ACTOR, PROJECT_ID, { to: "2026-10-31" });

    const values = sqlValues(capturedConds);
    expect(values).toContain("2026-10-31");
  });

  it("status filter injects the status value into the where clause so only cycles of that status pass the DB predicate", async () => {
    const capturedConds: unknown[] = [];
    const row = makeBaseRow(1, "2026-10-01");
    const db = makeDb([row], capturedConds);
    const service = new CyclesService(db, stubService<AccessService>({}));
    await service.listCycles(ACTOR, PROJECT_ID, { status: "active" });

    const values = sqlValues(capturedConds);
    expect(values).toContain("active");
  });
});
