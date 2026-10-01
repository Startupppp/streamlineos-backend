import { PgDialect } from "drizzle-orm/pg-core";
import { BugsService } from "./bugs.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { principalAccess, projectAccessRow } from "../core/project-crud/__tests__/project-access-doubles";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const projectRow = { from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) };
  return {
    select: jest.fn().mockReturnValueOnce(projectRow).mockReturnValue(builder),
  } as unknown as Db;
}

function makeOwner(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

const mockAccess = principalAccess() as unknown as AccessService;
const mockAudit = {} as AuditService;

describe("BugsService.listBugs — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the ticket title column can use a prefix index rather than a full scan over the project's bug rows", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BugsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listBugs(makeOwner("org-1"), 1, { q: "crash" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'crash' finds 'Crash on login' — the title begins with the typed term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BugsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listBugs(makeOwner("org-1"), 1, { q: "crash" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("crash%");
  });

  it("omits the ilike predicate when no q is given so all bugs in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new BugsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listBugs(makeOwner("org-1"), 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
