import { PgDialect } from "drizzle-orm/pg-core";
import { TestRunsService } from "./test-runs.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { BuildTicketCreationService } from "../core/tickets";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
      },
    },
    select: jest.fn().mockReturnValue(builder),
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

const mockAccess = {} as AccessService;
const mockAudit = {} as AuditService;
const mockTicketCreation = {} as BuildTicketCreationService;

describe("TestRunsService.listRuns — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the test run name column can use a prefix index rather than a full scan over the project's run rows", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestRunsService(buildDb(captured), mockAccess, mockAudit, mockTicketCreation);
    await svc.listRuns(makeOwner("org-1"), 1, { q: "sprint" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'sprint' finds 'Sprint 12 Run' — the name begins with the typed term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestRunsService(buildDb(captured), mockAccess, mockAudit, mockTicketCreation);
    await svc.listRuns(makeOwner("org-1"), 1, { q: "sprint" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("sprint%");
  });

  it("omits the ilike predicate when no q is given so all runs in the project are returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new TestRunsService(buildDb(captured), mockAccess, mockAudit, mockTicketCreation);
    await svc.listRuns(makeOwner("org-1"), 1, {});
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
