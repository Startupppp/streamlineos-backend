import { PgDialect } from "drizzle-orm/pg-core";
import { TestManagementService } from "./test-management.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { principalAccess, projectAccessRow } from "../__tests__/project-access-doubles";
import { lifecycleAuditDouble } from "../lifecycle/audit-double";

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

describe("TestManagementService.listCases — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the test case title column can use a prefix index rather than a full scan over the suite", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestManagementService(buildDb(captured), mockAccess, lifecycleAuditDouble());
    await svc.listCases(makeOwner("org-1"), 1, { q: "login" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'login' finds 'Login with SSO' — the title starts with the typed term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestManagementService(buildDb(captured), mockAccess, lifecycleAuditDouble());
    await svc.listCases(makeOwner("org-1"), 1, { q: "login" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("login%");
  });

  it("omits the ilike predicate when no q is given so all test cases in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestManagementService(buildDb(captured), mockAccess, lifecycleAuditDouble());
    await svc.listCases(makeOwner("org-1"), 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
