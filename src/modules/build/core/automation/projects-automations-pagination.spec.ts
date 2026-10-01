import { decodeCursor } from "../../../../common/pagination/cursor";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsAutomationsService } from "./projects-automations.service";

jest.mock("../project-crud/project-access", () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertCanManageProject: jest.fn().mockResolvedValue(undefined),
}));

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

function makeDb(pageResponses: unknown[][]) {
  let callIndex = 0;
  const capturedWhereConds: unknown[] = [];
  const limit = jest.fn().mockImplementation(() => Promise.resolve(pageResponses[callIndex++] ?? []));
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWhereConds.push(cond);
    return { orderBy };
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as unknown as Db, capturedWhereConds };
}

function makeRow(id: number, createdAt: Date) {
  return {
    id,
    projectId: 1,
    name: `Auto ${id}`,
    triggerEvent: "ticket.created",
    isActive: true,
    conditions: [],
    actions: [],
    createdBy: null,
    lastRunAt: null,
    lastFailureAt: null,
    createdAt,
    updatedAt: createdAt,
    createdByUser: null,
  };
}

const planLimits = { assertWithinLimit: jest.fn() } as never;
const access = {} as never;
const u = { orgId: "org-1", userId: "user-1" } as never;

describe("ProjectsAutomationsService — cursor pagination (BE-25)", () => {
  it("beyond-first-page rows are reachable — paging through returns all rows exactly once with no skips (proves row 101 is reachable)", async () => {
    const rows = [4, 3, 2, 1].map((id) =>
      makeRow(id, new Date(`2024-01-0${id}T00:00:00.000Z`)),
    );
    const { db } = makeDb([
      rows.slice(0, 4),
      rows.slice(3, 4),
    ]);
    const svc = new ProjectsAutomationsService(db, planLimits, access);

    const page1 = await svc.listAutomations(u, 1, { limit: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.pagination.nextCursor).not.toBeNull();

    const page2 = await svc.listAutomations(u, 1, {
      limit: 3,
      cursor: page1.pagination.nextCursor!,
    });
    expect(page2.data).toHaveLength(1);
    expect(page2.pagination.hasMore).toBe(false);
    expect(page2.pagination.nextCursor).toBeNull();

    const allIds = [...page1.data.map((r) => r.id), ...page2.data.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(4);
    expect(allIds.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("hasMore is true when the sentinel row is present and false on the last page", async () => {
    const rows = [2, 1].map((id) =>
      makeRow(id, new Date(`2024-01-0${id}T00:00:00.000Z`)),
    );
    const { db: db1 } = makeDb([rows]);
    const svc1 = new ProjectsAutomationsService(db1, planLimits, access);
    const fullPage = await svc1.listAutomations(u, 1, { limit: 1 });
    expect(fullPage.pagination.hasMore).toBe(true);

    const { db: db2 } = makeDb([[rows[1]]]);
    const svc2 = new ProjectsAutomationsService(db2, planLimits, access);
    const lastPage = await svc2.listAutomations(u, 1, { limit: 1 });
    expect(lastPage.pagination.hasMore).toBe(false);
  });

  it("nextCursor is null exactly when hasMore is false — the two fields are always coherent", async () => {
    const rows = [2, 1].map((id) =>
      makeRow(id, new Date(`2024-01-0${id}T00:00:00.000Z`)),
    );
    const { db: db1 } = makeDb([rows]);
    const svc1 = new ProjectsAutomationsService(db1, planLimits, access);
    const fullPage = await svc1.listAutomations(u, 1, { limit: 1 });
    expect(fullPage.pagination.hasMore).toBe(true);
    expect(fullPage.pagination.nextCursor).not.toBeNull();

    const { db: db2 } = makeDb([[rows[0]]]);
    const svc2 = new ProjectsAutomationsService(db2, planLimits, access);
    const lastPage = await svc2.listAutomations(u, 1, { limit: 1 });
    expect(lastPage.pagination.hasMore).toBe(false);
    expect(lastPage.pagination.nextCursor).toBeNull();
  });

  it("no total field is present in the response — keyset pages must not fake a count (BE-25)", async () => {
    const { db } = makeDb([[makeRow(1, new Date())]]);
    const svc = new ProjectsAutomationsService(db, planLimits, access);
    const page = await svc.listAutomations(u, 1, { limit: 50 });
    const p = page as unknown as Record<string, unknown>;
    expect(p["total"]).toBeUndefined();
    const pag = page.pagination as unknown as Record<string, unknown>;
    expect(pag["total"]).toBeUndefined();
    expect(pag["totalPages"]).toBeUndefined();
  });

  it("malformed cursor yields the first page rather than a 500 — a stale or hand-edited cursor is a client problem", async () => {
    const rows = [makeRow(1, new Date())];
    const { db } = makeDb([rows]);
    const svc = new ProjectsAutomationsService(db, planLimits, access);
    const page = await svc.listAutomations(u, 1, {
      limit: 50,
      cursor: "not!!valid!!base64!!cursor",
    });
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(false);
  });

  it("cursor carries both createdAt and id so rows sharing a createdAt timestamp are not skipped across a page boundary — tiebreak test", async () => {
    const T = new Date("2024-01-01T12:00:00.000Z");
    const rowA = makeRow(5, T);
    const rowB = makeRow(3, T);

    const { db } = makeDb([[rowA, rowB], [rowB]]);
    const svc = new ProjectsAutomationsService(db, planLimits, access);

    const page1 = await svc.listAutomations(u, 1, { limit: 1 });
    expect(page1.data[0].id).toBe(5);
    expect(page1.pagination.hasMore).toBe(true);

    const decoded = decodeCursor(page1.pagination.nextCursor!);
    expect(decoded).not.toBeNull();
    expect(decoded!.sortValue).toBe(T.toISOString());
    expect(decoded!.id).toBe("5");

    const page2 = await svc.listAutomations(u, 1, {
      limit: 1,
      cursor: page1.pagination.nextCursor!,
    });
    expect(page2.data[0].id).toBe(3);
    expect(page2.pagination.hasMore).toBe(false);
  });

  it("where is called exactly once per listAutomations call — both page 1 and page 2 route through the keyset WHERE clause", async () => {
    const T = new Date("2024-01-01T12:00:00.000Z");
    const rowA = makeRow(5, T);
    const { db, capturedWhereConds } = makeDb([[rowA], []]);
    const svc = new ProjectsAutomationsService(db, planLimits, access);

    const page1 = await svc.listAutomations(u, 1, { limit: 1 });
    await svc.listAutomations(u, 1, {
      limit: 1,
      cursor: page1.pagination.nextCursor!,
    });

    expect(capturedWhereConds).toHaveLength(2);
    expect(sqlValues(capturedWhereConds[0])).toContain("org-1");
    expect(sqlValues(capturedWhereConds[1])).toContain("org-1");
  });
});
