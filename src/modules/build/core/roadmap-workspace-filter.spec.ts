import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "../../../db/schema";
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import type { Db } from "../../../db/drizzle.module";

const realDb = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), { schema });
const dialect = new PgDialect();
const ORG = "org-ws-scope";

function makeService(findMany: jest.Mock) {
  const db = {
    select: (...args: Parameters<typeof realDb.select>) => realDb.select(...args),
    query: { roadmapItems: { findMany } },
  } as unknown as Db;
  return new ProjectsRoadmapService(db, {} as never, {} as never);
}

function capturedWhere(findMany: jest.Mock, callIndex = 0): unknown {
  const w = findMany.mock.calls[callIndex]?.[0]?.where;
  if (!w) throw new Error(`no where clause on call ${callIndex}`);
  return w;
}

function whereParams(findMany: jest.Mock, callIndex = 0): unknown[] {
  return dialect.sqlToQuery(capturedWhere(findMany, callIndex) as Parameters<PgDialect["sqlToQuery"]>[0]).params;
}

function whereSql(findMany: jest.Mock, callIndex = 0): string {
  return dialect.sqlToQuery(capturedWhere(findMany, callIndex) as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("ProjectsRoadmapService.listRoadmap — workspace and product filters", () => {
  describe("pmWorkspaceId filter", () => {
    it("adds pmWorkspaceId as a bound param when the filter is supplied", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20, pmWorkspaceId: "ws-abc" });
      expect(whereParams(findMany)).toContain("ws-abc");
    });

    it("also binds the caller org_id in the same predicate (cross-tenant isolation)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20, pmWorkspaceId: "ws-abc" });
      const params = whereParams(findMany);
      expect(params).toContain(ORG);
      expect(params).toContain("ws-abc");
    });

    it("does NOT add a pm_workspace_id predicate when pmWorkspaceId is absent (negative gate)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20 });
      expect(whereSql(findMany)).not.toContain("pm_workspace_id");
    });
  });

  describe("managedProductId filter", () => {
    it("adds managedProductId as a bound param when the filter is supplied", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20, managedProductId: 42 });
      expect(whereParams(findMany)).toContain(42);
    });

    it("also binds the caller org_id in the same predicate (cross-tenant isolation)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20, managedProductId: 42 });
      const params = whereParams(findMany);
      expect(params).toContain(ORG);
      expect(params).toContain(42);
    });

    it("does NOT add a managed_product_id predicate when managedProductId is absent (negative gate)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      await makeService(findMany).listRoadmap(ORG, { limit: 20 });
      expect(whereSql(findMany)).not.toContain("managed_product_id");
    });
  });

  it("binds org_id on every call regardless of which filters are active (cross-tenant baseline)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeService(findMany);

    await svc.listRoadmap(ORG, { limit: 20 });
    await svc.listRoadmap(ORG, { limit: 20, pmWorkspaceId: "ws-1" });
    await svc.listRoadmap(ORG, { limit: 20, managedProductId: 7 });

    expect(whereParams(findMany, 0)).toContain(ORG);
    expect(whereParams(findMany, 1)).toContain(ORG);
    expect(whereParams(findMany, 2)).toContain(ORG);
  });
});
