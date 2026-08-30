import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { ProjectsWorkspaceMembersService } from "./projects-workspace-members.service";
import { ProjectsBudgetService } from "./projects-budget.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
  return { userId: "u1", orgId, isOrgOwner: false, sessionId: "s1" } as CurrentUserContext;
}

describe("ProjectsAnalyticsService — cross-tenant isolation", () => {
  it("getProjectAnalytics scopes queries to requesting org (cross-tenant isolation)", async () => {
    const selectWhere = jest.fn().mockReturnValue({
      groupBy: jest.fn().mockResolvedValue([]),
      leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }),
      orderBy: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: selectWhere,
          leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }),
        }),
      }),
    } as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: string, fn: () => unknown) => fn()) } as unknown as CacheService;
    const svc = new ProjectsAnalyticsService(db, cache);

    await svc.getProjectAnalytics(ATTACKER_ORG, 1);

    const wasCalled = (db.select as jest.Mock).mock.calls.length > 0;
    expect(wasCalled).toBe(true);
    const allCallArgs = selectWhere.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allCallArgs).toContain(ATTACKER_ORG);
    expect(allCallArgs).not.toContain(OWNER_ORG);
  });

  it("getProjectAnalytics works for the owning org (control — same-tenant access works)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockResolvedValue([]),
            leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }),
            orderBy: jest.fn().mockResolvedValue([]),
          }),
          leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }),
        }),
      }),
    } as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: string, fn: () => unknown) => fn()) } as unknown as CacheService;
    const svc = new ProjectsAnalyticsService(db, cache);

    const result = await svc.getProjectAnalytics(OWNER_ORG, 1);
    expect(result).toBeDefined();
  });
});

describe("ProjectsWorkspaceMembersService — cross-tenant isolation", () => {
  it("list scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue([]) }) }),
    });
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }) }) };
        }
        return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ total: 0 }]) }) }) };
      }),
    } as unknown as Db;
    const audit = {} as unknown as AuditService;
    const pmWorkspaces = { assertAccess: jest.fn().mockResolvedValue(undefined) } as unknown as PmWorkspacesService;
    const svc = new ProjectsWorkspaceMembersService(db, audit, pmWorkspaces);

    const result = await svc.list(ATTACKER_ORG, { page: 1, limit: 10 });

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
          return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue([fakeMember]) }) }) }) }) }) };
        }
        if (call === 2) {
          return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ total: 1 }]) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const audit = {} as unknown as AuditService;
    const pmWorkspaces = { assertAccess: jest.fn().mockResolvedValue(undefined) } as unknown as PmWorkspacesService;
    const svc = new ProjectsWorkspaceMembersService(db, audit, pmWorkspaces);

    const result = await svc.list(OWNER_ORG, { page: 1, limit: 10 });
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
      query: { projects: { findFirst: jest.fn().mockResolvedValue(fakeProject) } },
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
