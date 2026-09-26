import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ClientPortalService } from "./client-portal.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();

function renderSql(predicate: unknown): string {
  if (!is(predicate, SQL)) return "";
  return dialect.sqlToQuery(predicate).sql;
}

function makeU(orgId: string): CurrentUserContext {
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
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

const mockAudit = { log: jest.fn(), logCritical: jest.fn() } as unknown as AuditService;

const ALL_CAPS_GRANT = {
  canViewMilestones: true,
  canViewTasks: true,
  canViewAttachments: true,
  canViewComments: true,
};

const MINIMAL_PROJECT = {
  id: 10,
  name: "Beta",
  key: "B",
  status: "active",
  startDate: null,
  targetEndDate: null,
  managerMembershipId: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set(["build:view"]));
});

describe("ClientPortalService.listPortalProjects — lifecycle gate: isNull(deletedAt) on project rows (Requirement B)", () => {
  it("projects query WHERE predicate contains 'deleted_at' so soft-deleted projects are excluded at the DB, not application code", async () => {
    const capturedWheres: unknown[] = [];
    let selectCount = 0;

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const idx = selectCount;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              capturedWheres.push({ idx, pred });
              return {
                limit: jest.fn().mockImplementation(() => {
                  if (idx === 1) return Promise.resolve([{ id: "pm-1" }]); // portalMemberships
                  if (idx === 2) return Promise.resolve([{ projectId: 10 }]); // grants
                  return Promise.resolve([MINIMAL_PROJECT]); // projects
                }),
              };
            }),
          }),
        };
      }),
    } as unknown as Db;

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.listPortalProjects("org-1", 7);

    expect(selectCount).toBe(3);
    const projectWhere = capturedWheres.find((e) => (e as { idx: number }).idx === 3) as { idx: number; pred: unknown };
    expect(projectWhere).toBeDefined();
    expect(renderSql(projectWhere.pred)).toContain("deleted_at");
  });

  it("returns an empty array when the projects query returns nothing (mirrors soft-deleted exclusion)", async () => {
    let selectCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const idx = selectCount;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                if (idx === 1) return Promise.resolve([{ id: "pm-1" }]);
                if (idx === 2) return Promise.resolve([{ projectId: 10 }]);
                return Promise.resolve([]); // no matching (non-deleted) projects
              }),
            }),
          }),
        };
      }),
    } as unknown as Db;

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.listPortalProjects("org-1", 7);
    expect(result).toHaveLength(0);
  });
});

describe("ClientPortalService.getProjectOverview — source ACL gate: clientVisible=true on sub-resource rows (Requirement E)", () => {
  function makeOverviewDb(capturedPredicates: Array<{ idx: number; pred: unknown }>) {
    let selectCount = 0;

    const stubFromChain = (idx: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ idx, pred });
        return {
          limit: jest.fn().mockImplementation(() => {
            if (idx === 1) return Promise.resolve([MINIMAL_PROJECT]); // project
            return Promise.resolve([]);
          }),
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(() => {
              if (idx === 2) return Promise.resolve([ALL_CAPS_GRANT]); // grant
              return Promise.resolve([]);
            }),
          }),
        };
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: unknown) => {
          capturedPredicates.push({ idx, pred });
          return { limit: jest.fn().mockResolvedValue([]) };
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedPredicates.push({ idx, pred });
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    });

    return {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue(MINIMAL_PROJECT),
        },
      },
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const ci = selectCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      }),
    } as unknown as Db;
  }

  it("milestones WHERE predicate contains 'client_visible' so internal milestones not flagged for portal are excluded at the DB", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    // idx 3 = milestones (after 1=project, 2=grant)
    const milestoneEntry = capturedPredicates.find((e) => e.idx === 3);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("client_visible");
  });

  it("tasks WHERE predicate contains 'client_visible' so internal tickets not flagged for portal are excluded at the DB", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    // idx 4 = tasks
    const taskEntry = capturedPredicates.find((e) => e.idx === 4);
    expect(taskEntry).toBeDefined();
    expect(renderSql(taskEntry!.pred)).toContain("client_visible");
  });

  it("project query WHERE predicate contains 'deleted_at' so a soft-deleted project is excluded at the DB", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    // idx 1 = project query
    const projectEntry = capturedPredicates.find((e) => e.idx === 1);
    expect(projectEntry).toBeDefined();
    expect(renderSql(projectEntry!.pred)).toContain("deleted_at");
  });
});
