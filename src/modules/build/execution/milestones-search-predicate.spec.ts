import { PgDialect } from "drizzle-orm/pg-core";
import { MilestonesService } from "./workspace.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { principalAccess, projectAccessRow } from "../__tests__/project-access-doubles";

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
  return {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
      },
    },
    select: jest.fn((projection: Record<string, unknown> = {}) =>
      "manages" in projection
        ? { from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) }
        : builder,
    ),
  } as unknown as Db;
}

function makeOwner(orgId: string) {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER" as const,
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

const mockAccess = principalAccess() as unknown as AccessService;
const mockAudit = {} as AuditService;

describe("MilestonesService.listMilestones — search predicate shape (BE-49)", () => {
  it("uses full-text search so mid-name matches are found, not just prefix matches", async () => {
    const captured: Captured = { where: undefined };
    const svc = new MilestonesService(buildDb(captured), mockAccess, mockAudit);
    await svc.listMilestones(makeOwner("org-1"), 1, { limit: 20, q: "beta" });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("to_tsvector");
    expect(sql.toLowerCase()).toContain("plainto_tsquery");
  });

  it("places the search term directly in params without a wildcard suffix", async () => {
    const captured: Captured = { where: undefined };
    const svc = new MilestonesService(buildDb(captured), mockAccess, mockAudit);
    await svc.listMilestones(makeOwner("org-1"), 1, { limit: 20, q: "beta" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(params).toContain("beta");
    expect(params.every((p) => typeof p !== "string" || !p.includes("%"))).toBe(true);
  });

  it("omits the fts predicate when no q is given so all milestones in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new MilestonesService(buildDb(captured), mockAccess, mockAudit);
    await svc.listMilestones(makeOwner("org-1"), 1, { limit: 20 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("plainto_tsquery");
  });
});
