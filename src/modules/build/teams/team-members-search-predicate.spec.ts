import { PgDialect } from "drizzle-orm/pg-core";
import { TeamMembersService } from "./team-members.service";
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
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  const teams = {
    loadTeam: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1" }),
  } as unknown as TeamsService;
  return { db, teams };
}

const mockAudit = {} as AuditService;

describe("TeamMembersService.listTeamMembers — search predicate shape (BE-49 does not apply: users is not RLS-enabled and carries gin_trgm indexes)", () => {
  it("keeps the substring pattern on the global users table, because migrations 0007 and 1067 built gin_trgm indexes that serve it and 1067 records that users has relrowsecurity = f, so BE-80's dead-index premise does not hold here", async () => {
    const captured: Captured = { where: undefined };
    const { db, teams } = buildDb(captured);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await svc.listTeamMembers("org-1", 1, { pageSize: 20, q: "bob" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => p.startsWith("%") && p.endsWith("%"))).toBe(true);
  });

  it("escapes the term inside the wildcards so a member typing a bare % cannot widen the search to the whole directory", async () => {
    const captured: Captured = { where: undefined };
    const { db, teams } = buildDb(captured);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await svc.listTeamMembers("org-1", 1, { pageSize: 20, q: "bob" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => p === "%bob%")).toBe(true);
  });

  it("omits all ilike conditions when q is absent so the full team membership is returned", async () => {
    const captured: Captured = { where: undefined };
    const { db, teams } = buildDb(captured);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await svc.listTeamMembers("org-1", 1, { pageSize: 20 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
