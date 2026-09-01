import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { decodeCursor } from "../../../common/pagination/cursor";
import { ProjectsRoadmapService } from "./projects-roadmap.service";

const dialect = new PgDialect();
const ORG = "org-s04";

interface RoadmapRow {
  id: number;
  sortOrder: number;
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
    const position = decodeCursor(first.pagination.nextCursor);
    expect(first.data.map((row) => row.id)).toEqual([10, 11]);
    expect(position).toEqual({ sortValue: "1", id: "11" });

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
});
