import { PgDialect } from "drizzle-orm/pg-core";
import { TeamsService } from "./teams.service";
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

describe("TeamsService.listTeams — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the team name column can use a prefix index rather than a full scan over the org's teams", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TeamsService(buildDb(captured), mockAudit);
    await svc.listTeams("org-1", { pageSize: 20, search: "frontend" }, null);
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'front' finds 'Frontend Team' because the name starts with the typed term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TeamsService(buildDb(captured), mockAudit);
    await svc.listTeams("org-1", { pageSize: 20, search: "front" }, null);
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("front%");
  });

  it("omits the ilike predicate when no search term is given so all org teams are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TeamsService(buildDb(captured), mockAudit);
    await svc.listTeams("org-1", { pageSize: 20 }, null);
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
