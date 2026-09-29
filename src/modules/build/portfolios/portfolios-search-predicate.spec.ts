import { PgDialect } from "drizzle-orm/pg-core";
import { PortfoliosService } from "./portfolios.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

const mockAudit = {} as AuditService;

describe("PortfoliosService.listPortfolios — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the portfolio name column can use a prefix index rather than a full scan", async () => {
    const captured: Captured = { where: undefined };
    const svc = new PortfoliosService(buildDb(captured), mockAudit);
    await svc.listPortfolios("org-1", { limit: 20, q: "strategic" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'strategic' finds 'Strategic Growth' because the name starts with the typed prefix", async () => {
    const captured: Captured = { where: undefined };
    const svc = new PortfoliosService(buildDb(captured), mockAudit);
    await svc.listPortfolios("org-1", { limit: 20, q: "strategic" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("strategic%");
  });

  it("omits the ilike predicate when no q is given so all portfolios are visible to the caller", async () => {
    const captured: Captured = { where: undefined };
    const svc = new PortfoliosService(buildDb(captured), mockAudit);
    await svc.listPortfolios("org-1", { limit: 20 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
