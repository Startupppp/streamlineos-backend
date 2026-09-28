import type { Db } from "../../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { BuildMembersService } from "../members/build-members.service";
import { ProjectsBudgetService } from "../budget/projects-budget.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
function passThroughCache() {
  return {
    cachedVersioned: <T>(_namespace: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}


function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeCtx(orgId: string): CurrentUserContext {
  return { userId: "u1", orgId, isOrgOwner: false, sessionId: "s1", principal: { kind: "human-session", membershipId: 1, isOrgOwner: false } } as unknown as CurrentUserContext;
}

function makeAnalyticsDb(): { db: Db; capturedWheres: unknown[]; capturedJoins: unknown[]; projectFindFirst: jest.Mock; execute: jest.Mock } {
  const capturedWheres: unknown[] = [];
  const capturedJoins: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const resolved = Promise.resolve([]);
  const chainMethods = ["from", "where", "leftJoin", "innerJoin", "groupBy", "orderBy", "limit", "offset", "having"];
  for (const m of chainMethods) {
    chain[m] = jest.fn().mockImplementation((arg: unknown, condArg?: unknown) => {
      if (m === "where") capturedWheres.push(arg);
      if ((m === "leftJoin" || m === "innerJoin") && condArg !== undefined) capturedJoins.push(condArg);
      return chain;
    });
  }
  chain.then = (fn: (v: unknown[]) => unknown) => resolved.then(fn);
  chain.catch = (fn: (e: unknown) => unknown) => resolved.catch(fn);
  chain.finally = (fn: () => void) => resolved.finally(fn);
  const projectFindFirst = jest.fn().mockResolvedValue({ id: 1 });
  const execute = jest.fn().mockResolvedValue([]);
  const db = {
    query: { projects: { findFirst: projectFindFirst } },
    select: jest.fn().mockReturnValue(chain),
    execute,
  } as unknown as Db;
  return { db, capturedWheres, capturedJoins, projectFindFirst, execute };
}

describe("ProjectsAnalyticsService — cross-tenant isolation", () => {
  it("getProjectAnalytics scopes queries to requesting org (cross-tenant isolation)", async () => {
    const { db, capturedWheres } = makeAnalyticsDb();
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    await svc.getProjectAnalytics(ATTACKER_ORG, 1);

    expect((db.select as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    const allCallArgs = capturedWheres.flatMap((w) => sqlValues(w));
    expect(allCallArgs).toContain(ATTACKER_ORG);
    expect(allCallArgs).not.toContain(OWNER_ORG);
  });

  it("getProjectAnalytics refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const { db, projectFindFirst } = makeAnalyticsDb();
    projectFindFirst.mockResolvedValue(undefined);
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    await expect(svc.getProjectAnalytics(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("getProjectAnalytics works for the owning org (control — same-tenant access works)", async () => {
    const { db } = makeAnalyticsDb();
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    const result = await svc.getProjectAnalytics(OWNER_ORG, 1);
    expect(result).toBeDefined();
  });

  it("getProjectAnalytics cycleVelocity LEFT JOIN binds org_id on tickets so a ticket whose cycleId matches a cross-org cycle is never joined", async () => {
    const { db, capturedJoins } = makeAnalyticsDb();
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    await svc.getProjectAnalytics(ATTACKER_ORG, 1);

    const allJoinValues = capturedJoins.flatMap((j) => sqlValues(j));
    expect(allJoinValues).toContain(ATTACKER_ORG);
    expect(allJoinValues).not.toContain(OWNER_ORG);
  });

  it("getOrgProjectHealthSummary aggregates only the requesting org and excludes soft-deleted projects and tickets", async () => {
    const { db, execute } = makeAnalyticsDb();
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    await svc.getOrgProjectHealthSummary(ATTACKER_ORG);

    expect(execute).toHaveBeenCalledTimes(1);
    const values = sqlValues(execute.mock.calls[0]?.[0]);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    const sqlText = values.filter((value): value is string => typeof value === "string").join(" ");
    expect(sqlText).toContain("build.projects");
    expect(sqlText).toContain("p.deleted_at IS NULL");
    expect(sqlText).toContain("t.deleted_at IS NULL");
    expect(sqlText).toContain("COUNT(*) FILTER");
  });

  it("getProjectAnalytics assigneeCompletion queries build.ticket_assignees via db.execute so multi-assigned users are not invisible in completion stats", async () => {
    const { db, execute } = makeAnalyticsDb();
    const svc = new ProjectsAnalyticsService(db, passThroughCache());

    await svc.getProjectAnalytics(ATTACKER_ORG, 1);

    expect(execute).toHaveBeenCalled();
    const sqlArg = execute.mock.calls[0]?.[0];
    const paramValues = sqlValues(sqlArg);
    expect(paramValues).toContain(ATTACKER_ORG);
    expect(paramValues).not.toContain(OWNER_ORG);
    const sqlText = paramValues.filter((value): value is string => typeof value === "string").join(" ");
    expect(sqlText).toContain("build.ticket_assignees");
    expect(sqlText).toContain("assignee_membership_id");
  });
});

describe("BuildMembersService — cross-tenant isolation", () => {
  it("list scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }) }) }),
      }),
    } as unknown as Db;
    const audit = {} as unknown as AuditService;
    const svc = new BuildMembersService(db, audit);

    const result = await svc.list(ATTACKER_ORG, { cursor: undefined, limit: 10 });

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result.data).toHaveLength(0);
  });

  it("list returns members for the owning org (control — same-tenant access works)", async () => {
    const fakeMember = { id: "u1", role: "VIEWER", addedAt: new Date(), name: "Alice", firstName: null, lastName: null, email: "a@b.com", image: null };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeMember]) }) }) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }) }) };
      }),
    } as unknown as Db;
    const audit = {} as unknown as AuditService;
    const svc = new BuildMembersService(db, audit);

    const result = await svc.list(OWNER_ORG, { cursor: undefined, limit: 10 });
    expect(result.data).toHaveLength(1);
  });
});

describe("ProjectsBudgetService — cross-tenant isolation", () => {
  it("getBudget throws NotFoundException when project not found for attacker org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    } as unknown as Db;
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new ProjectsBudgetService(db, access);
    const u = makeCtx(ATTACKER_ORG);

    await expect(svc.getBudget(u, 9999)).rejects.toThrow(NotFoundException);
  });

  it("getBudget returns budget data for the owning org (control — same-tenant access works)", async () => {
    const fakeProject = { id: 1, orgId: OWNER_ORG, budgetMinor: 50000, budgetCurrency: "INR", managerId: "u1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(fakeProject) },
        projectMembers: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }),
        }),
      }),
    } as unknown as Db;
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
    const svc = new ProjectsBudgetService(db, access);
    const u = makeCtx(OWNER_ORG);

    const result = await svc.getBudget(u, 1);
    expect(result).toBeDefined();
  });
});
