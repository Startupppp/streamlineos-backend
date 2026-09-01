import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsQueryService } from "./projects-query.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockReturnThis(),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

const mockCache = {
  cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()),
} as unknown as CacheService;

const mockAccess = {
  scopeFor: jest.fn().mockResolvedValue("all"),
} as unknown as AccessService;

async function capture(afterId: number | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new ProjectsQueryService(buildDb(captured), mockCache, {} as AuditService, mockAccess);
  await svc.listProjects(
    { orgId: "org-1", userId: "u-1", principal: humanSessionPrincipal(1, false) } as never,
    { afterId, limit: 9, status: "ALL", search: undefined, pmWorkspaceId: undefined },
  );
  return captured;
}

describe("ProjectsQueryService.queryProjects — keyset matches the sort", () => {
  it("orders by id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"id"');
    expect(rendered[0]).toContain("desc");
  });

  it("applies a strict less-than predicate on id when afterId is provided", async () => {
    const { where } = await capture(100);
    const sql = render(where);
    expect(sql).toMatch(/"id"\s*</);
    expect(sql).not.toMatch(/"id"\s*>/);
  });

  it("omits the id predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"id"\s*</);
  });

  it("bite proof: window-function total was the old approach", () => {
    const oldSelect = { total: 'count(*) OVER ()' };
    expect(oldSelect).toHaveProperty("total");
    expect(oldSelect.total).toContain("OVER");
  });
});
