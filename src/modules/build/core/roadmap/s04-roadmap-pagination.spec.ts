import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../../db/drizzle.module";
import { decodeTupleCursor } from "../../../../common/pagination/cursor";
import { ProjectsRoadmapService } from "./projects-roadmap.service";

const dialect = new PgDialect();
const ORG = "org-s04";

interface RoadmapRow {
  id: number;
  sortOrder: number;
  updatedAt?: Date;
  createdAt?: Date;
  title?: string;
}

function makeService(findMany: jest.Mock) {
  const db = { query: { roadmapItems: { findMany } } } as unknown as Db;
  return new ProjectsRoadmapService(db);
}

function queryParams(findMany: jest.Mock, callIndex: number): unknown[] {
  const where = findMany.mock.calls[callIndex]?.[0]?.where;
  if (!where) throw new Error("expected a where clause");
  return dialect.sqlToQuery(where).params;
}

function querySql(findMany: jest.Mock, callIndex: number): string {
  const where = findMany.mock.calls[callIndex]?.[0]?.where;
  if (!where) throw new Error("expected a where clause");
  return dialect.sqlToQuery(where).sql;
}

describe("S04 roadmap projectId filter", () => {
  it("projectId predicate touches the project_id column — query A returns only that project's items", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1, sortOrder: 0 }]);
    const service = makeService(findMany);

    await service.listRoadmap(ORG, { limit: 20, projectId: 7 });

    expect(querySql(findMany, 0)).toContain("project_id");
    expect(queryParams(findMany, 0)).toContain(7);
  });

  it("omitting projectId does not add a project_id predicate to the SQL", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = makeService(findMany);

    await service.listRoadmap(ORG, { limit: 20 });

    expect(querySql(findMany, 0)).not.toMatch(/project_id\s*=\s*\$/);
  });
});

describe("S04 roadmap ownerId filter", () => {
  it("ownerId predicate touches the owner_membership_id column — query filters items by assigned owner", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 3, sortOrder: 0 }]);
    const service = makeService(findMany);

    await service.listRoadmap(ORG, { limit: 20, ownerId: 42 });

    expect(querySql(findMany, 0)).toContain("owner_membership_id");
    expect(queryParams(findMany, 0)).toContain(42);
  });

  it("ownerId is accepted by roadmapListQuerySchema — a deep-linked ownerId no longer 400s", () => {
    const { roadmapListQuerySchema } = jest.requireActual<typeof import("../dto/roadmap.schemas")>("../dto/roadmap.schemas");
    const result = roadmapListQuerySchema.safeParse({ ownerId: "7" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ownerId).toBe(7);
  });

  it("omitting ownerId does not add an owner_membership_id predicate to the SQL", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = makeService(findMany);

    await service.listRoadmap(ORG, { limit: 20 });

    expect(querySql(findMany, 0)).not.toMatch(/owner_membership_id\s*=\s*\$/);
  });
});

describe("S04 roadmap horizon filter", () => {
  it("horizon predicate touches the target_quarter column — query B filters by horizon value", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 2, sortOrder: 0 }]);
    const service = makeService(findMany);

    await service.listRoadmap(ORG, { limit: 20, horizon: "Q3 2026" });

    expect(querySql(findMany, 0)).toContain("target_quarter");
    expect(queryParams(findMany, 0)).toContain("Q3 2026");
  });

  it("horizon is accepted by roadmapListQuerySchema — a deep-linked horizon no longer 400s", () => {
    const { roadmapListQuerySchema } = jest.requireActual<typeof import("../dto/roadmap.schemas")>("../dto/roadmap.schemas");
    const result = roadmapListQuerySchema.safeParse({ horizon: "Q2 2025" });
    expect(result.success).toBe(true);
  });
});

describe("S04 roadmap cursor contract", () => {
  it("keeps duplicate sort values in order and anchors the cursor on the last returned row", async () => {
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 10, sortOrder: 1 },
        { id: 11, sortOrder: 1 },
        { id: 12, sortOrder: 2 },
      ])
      .mockResolvedValueOnce([{ id: 12, sortOrder: 2 }]);
    const service = makeService(findMany);

    const first = await service.listRoadmap(ORG, { limit: 2 });
    const parts = decodeTupleCursor(first.pagination.nextCursor ?? null, 3);
    expect(first.data.map((row) => row.id)).toEqual([10, 11]);
    expect(parts).toEqual(["sort_order", "1", "11"]);

    const last = await service.listRoadmap(ORG, {
      limit: 2,
      cursor: first.pagination.nextCursor ?? undefined,
    });
    expect(last.data.map((row) => row.id)).toEqual([12]);
    expect(last.pagination).toMatchObject({ hasMore: false, nextCursor: null });
    expect(querySql(findMany, 1)).toContain(">");
    expect(queryParams(findMany, 1)).toEqual(expect.arrayContaining([ORG, 1, 11]));
  });

  it("treats a malformed cursor as the first page and preserves the tenant predicate", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1, sortOrder: 1 }]);
    const service = makeService(findMany);

    const page = await service.listRoadmap(ORG, { limit: 2, cursor: "not-a-cursor" });

    expect(page.data).toEqual([{ id: 1, sortOrder: 1 }]);
    expect(queryParams(findMany, 0)).toContain(ORG);
    expect(querySql(findMany, 0)).not.toContain("sort_order");
  });

  it("returns an explicit null cursor for an empty last page", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = makeService(findMany);

    const page = await service.listRoadmap(ORG, { limit: 20 });

    expect(page.data).toEqual([]);
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.pagination.nextCursor).not.toBeUndefined();
    expect(page.pagination.hasMore).toBe(false);
  });

  it("pages past the first page under updated_at sort with no duplicates and no missing items", async () => {
    const t1 = new Date("2024-01-03T00:00:00.000Z");
    const t2 = new Date("2024-01-02T00:00:00.000Z");
    const t3 = new Date("2024-01-01T00:00:00.000Z");
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 10, sortOrder: 0, updatedAt: t1, createdAt: t1, title: "A" },
        { id: 11, sortOrder: 0, updatedAt: t2, createdAt: t2, title: "B" },
        { id: 12, sortOrder: 0, updatedAt: t3, createdAt: t3, title: "C" },
      ])
      .mockResolvedValueOnce([{ id: 12, sortOrder: 0, updatedAt: t3, createdAt: t3, title: "C" }]);
    const service = makeService(findMany);

    const first = await service.listRoadmap(ORG, { limit: 2, sort: "updated_at" });
    expect(first.data.map((r) => r.id)).toEqual([10, 11]);
    expect(first.pagination.hasMore).toBe(true);

    const parts = decodeTupleCursor(first.pagination.nextCursor ?? null, 3);
    expect(parts?.[0]).toBe("updated_at");
    expect(parts?.[2]).toBe("11");

    const second = await service.listRoadmap(ORG, {
      limit: 2,
      sort: "updated_at",
      cursor: first.pagination.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.id)).toEqual([12]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    expect(queryParams(findMany, 1)).toEqual(expect.arrayContaining([ORG, 11]));
  });

  it("pages past the first page under created_at sort with no duplicates and no missing items", async () => {
    const t1 = new Date("2024-03-03T00:00:00.000Z");
    const t2 = new Date("2024-03-02T00:00:00.000Z");
    const t3 = new Date("2024-03-01T00:00:00.000Z");
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 20, sortOrder: 0, updatedAt: t1, createdAt: t1, title: "X" },
        { id: 21, sortOrder: 0, updatedAt: t2, createdAt: t2, title: "Y" },
        { id: 22, sortOrder: 0, updatedAt: t3, createdAt: t3, title: "Z" },
      ])
      .mockResolvedValueOnce([{ id: 22, sortOrder: 0, updatedAt: t3, createdAt: t3, title: "Z" }]);
    const service = makeService(findMany);

    const first = await service.listRoadmap(ORG, { limit: 2, sort: "created_at" });
    expect(first.data.map((r) => r.id)).toEqual([20, 21]);
    expect(first.pagination.hasMore).toBe(true);

    const parts = decodeTupleCursor(first.pagination.nextCursor ?? null, 3);
    expect(parts?.[0]).toBe("created_at");
    expect(parts?.[2]).toBe("21");

    const second = await service.listRoadmap(ORG, {
      limit: 2,
      sort: "created_at",
      cursor: first.pagination.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.id)).toEqual([22]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    expect(queryParams(findMany, 1)).toEqual(expect.arrayContaining([ORG, 21]));
  });

  it("pages past the first page under title sort with no duplicates and no missing items", async () => {
    const t = new Date("2024-01-01T00:00:00.000Z");
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 30, sortOrder: 0, updatedAt: t, createdAt: t, title: "alpha" },
        { id: 31, sortOrder: 0, updatedAt: t, createdAt: t, title: "beta" },
        { id: 32, sortOrder: 0, updatedAt: t, createdAt: t, title: "gamma" },
      ])
      .mockResolvedValueOnce([{ id: 32, sortOrder: 0, updatedAt: t, createdAt: t, title: "gamma" }]);
    const service = makeService(findMany);

    const first = await service.listRoadmap(ORG, { limit: 2, sort: "title" });
    expect(first.data.map((r) => r.id)).toEqual([30, 31]);
    expect(first.pagination.hasMore).toBe(true);

    const parts = decodeTupleCursor(first.pagination.nextCursor ?? null, 3);
    expect(parts).toEqual(["title", "beta", "31"]);

    const second = await service.listRoadmap(ORG, {
      limit: 2,
      sort: "title",
      cursor: first.pagination.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.id)).toEqual([32]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    expect(queryParams(findMany, 1)).toEqual(expect.arrayContaining([ORG, "beta", 31]));
  });

  it("throws BadRequestException when a cursor issued under one sort is applied to a different ordering — policy: cross-sort cursor is rejected, not silently restarted as page 1", async () => {
    const t = new Date("2024-01-02T00:00:00.000Z");
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 40, sortOrder: 0, updatedAt: t, createdAt: t, title: "A" },
        { id: 41, sortOrder: 0, updatedAt: t, createdAt: t, title: "B" },
      ]);
    const service = makeService(findMany);

    const updatedAtFirst = await service.listRoadmap(ORG, { limit: 1, sort: "updated_at" });
    expect(updatedAtFirst.pagination.hasMore).toBe(true);

    await expect(
      service.listRoadmap(ORG, {
        limit: 1,
        cursor: updatedAtFirst.pagination.nextCursor ?? undefined,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("anchors equal-timestamp pages on the id tie-breaker — both cursor and boundary use the shared millisecond and the last-row id", async () => {
    const sharedMs = new Date("2024-06-15T12:00:00.000Z");
    const findMany = jest.fn<Promise<RoadmapRow[]>, [{ where: unknown; orderBy: unknown[]; limit: number }]>()
      .mockResolvedValueOnce([
        { id: 5, sortOrder: 0, updatedAt: sharedMs, createdAt: sharedMs, title: "A" },
        { id: 6, sortOrder: 0, updatedAt: sharedMs, createdAt: sharedMs, title: "B" },
        { id: 7, sortOrder: 0, updatedAt: sharedMs, createdAt: sharedMs, title: "C" },
      ])
      .mockResolvedValueOnce([{ id: 7, sortOrder: 0, updatedAt: sharedMs, createdAt: sharedMs, title: "C" }]);
    const service = makeService(findMany);

    const first = await service.listRoadmap(ORG, { limit: 2, sort: "updated_at" });
    expect(first.data.map((r) => r.id)).toEqual([5, 6]);
    expect(first.pagination.hasMore).toBe(true);

    const parts = decodeTupleCursor(first.pagination.nextCursor ?? null, 3);
    expect(parts?.[0]).toBe("updated_at");
    expect(parts?.[1]).toBe(sharedMs.toISOString());
    expect(parts?.[2]).toBe("6");

    const second = await service.listRoadmap(ORG, {
      limit: 2,
      sort: "updated_at",
      cursor: first.pagination.nextCursor ?? undefined,
    });
    expect(second.data.map((r) => r.id)).toEqual([7]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    const params = queryParams(findMany, 1);
    expect(params).toContain(ORG);
    expect(params).toContain(sharedMs.toISOString());
    expect(params).toContain(6);
  });
});
