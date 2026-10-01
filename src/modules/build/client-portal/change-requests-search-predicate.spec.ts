import { PgDialect } from "drizzle-orm/pg-core";
import { ChangeRequestsService } from "./change-requests.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { projectAccessRow } from "../core/project-crud/__tests__/project-access-doubles";

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
  return {
    select: jest.fn((fields?: Record<string, unknown>) =>
      fields !== undefined && "manages" in fields
        ? { from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) }
        : builder,
    ),
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

const mockAccess = {
  scopeFor: async (actor: CurrentUserContext) => (actor.isOrgOwner ? "all" : "none"),
} as unknown as AccessService;
const mockAudit = {} as AuditService;

describe("ChangeRequestsService.listChangeRequests — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so a btree prefix index can serve the query instead of falling back to a full scan", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ChangeRequestsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listChangeRequests(makeOwner("org-1"), 1, { limit: 25, q: "alpha" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so the search term is found when the title starts with it — e.g. 'add' matches 'Add SSO support'", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ChangeRequestsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listChangeRequests(makeOwner("org-1"), 1, { limit: 25, q: "add" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("add%");
  });

  it("omits the ilike predicate entirely when no q is given so all change requests remain visible", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ChangeRequestsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listChangeRequests(makeOwner("org-1"), 1, { limit: 25 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });

  it("escapes a % in the user input so typing '50%' searches for that literal string and does not match every title", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ChangeRequestsService(buildDb(captured), mockAccess, mockAudit);
    await svc.listChangeRequests(makeOwner("org-1"), 1, { limit: 25, q: "50%" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBeDefined();
    expect(likeParam).not.toBe("%50%%");
    expect(likeParam).not.toMatch(/^%/);
  });
});
