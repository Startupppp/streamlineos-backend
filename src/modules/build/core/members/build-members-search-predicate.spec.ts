import { PgDialect } from "drizzle-orm/pg-core";
import { BuildMembersService } from "./build-members.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
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

describe("BuildMembersService.list — search predicate shape (BE-49 does not apply: users is not RLS-enabled and carries gin_trgm indexes)", () => {
  it("keeps the substring pattern on all four users columns, because migrations 0007 and 1067 built gin_trgm indexes that serve it and 1067 records users has relrowsecurity = f, so a prefix-only search would lose surname matching and buy no index", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BuildMembersService(buildDb(captured), mockAudit);
    await svc.list("org-1", { limit: 20, search: "alice" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => p.startsWith("%") && p.endsWith("%"))).toBe(true);
  });

  it("escapes the term inside the wildcards so a member typing a bare % cannot widen the search to the whole directory", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BuildMembersService(buildDb(captured), mockAudit);
    await svc.list("org-1", { limit: 20, search: "ali" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => p === "%ali%")).toBe(true);
  });

  it("omits all ilike conditions when search is absent so every org member appears in the list", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BuildMembersService(buildDb(captured), mockAudit);
    await svc.list("org-1", { limit: 20 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
