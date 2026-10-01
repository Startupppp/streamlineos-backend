import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ClientPortalService } from "./client-portal.service";
import { buildPortalProjection } from "./portal-projection";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  type ProjectAccessRow,
} from "../core/project-crud/__tests__/project-access-doubles";

function projectGateSelect(rows: ProjectAccessRow[], rest: jest.Mock = jest.fn()): jest.Mock {
  return jest.fn((fields?: Record<string, unknown>) =>
    fields !== undefined && "manages" in fields
      ? { from: () => ({ where: () => ({ limit: async () => rows }) }) }
      : rest(fields),
  );
}


const memberScopeAccess = {
  scopeFor: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner ? "all" : (MEMBER_STANDING[key] ?? "none"),
  holds: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner || (MEMBER_STANDING[key] ?? "none") !== "none",
} as unknown as AccessService;

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

const mockAccess = memberScopeAccess;

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
  function makeOverviewDb(
    capturedPredicates: Array<{ idx: number; pred: unknown }>,
    capturedJoins: Array<{ idx: number; pred: unknown }> = [],
  ) {
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
      innerJoin: jest.fn().mockImplementation((_table: unknown, on: unknown) => {
        capturedJoins.push({ idx, pred: on });
        return {
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
        };
      }),
    });

    return {
      query: {
      },
      select: projectGateSelect([projectAccessRow()], jest.fn().mockImplementation(() => {
        selectCount++;
        const ci = selectCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      })),
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

  it("attachments JOIN requires the parent ticket's client_visible so an attachment on an internal-only ticket never reaches a portal client", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const capturedJoins: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates, capturedJoins);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    const attachmentJoin = capturedJoins.find((e) => e.idx === 5);
    expect(attachmentJoin).toBeDefined();
    expect(renderSql(attachmentJoin!.pred)).toContain("client_visible");
  });

  it("comments JOIN requires the parent ticket's client_visible so a comment on an internal-only ticket never reaches a portal client", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const capturedJoins: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates, capturedJoins);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    const commentJoin = capturedJoins.find((e) => e.idx === 6);
    expect(commentJoin).toBeDefined();
    expect(renderSql(commentJoin!.pred)).toContain("client_visible");
  });

  it("attachments and comments still filter their own client_visible flag so an internal note on a visible ticket stays private", async () => {
    const capturedPredicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeOverviewDb(capturedPredicates);

    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(makeU("org-1"), 10);

    for (const idx of [5, 6]) {
      const entry = capturedPredicates.find((e) => e.idx === idx);
      expect(entry).toBeDefined();
      expect(renderSql(entry!.pred)).toContain("client_visible");
    }
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

describe("buildPortalProjection — single projection seam shared by getProjectOverview and getPortalPreview", () => {
  function makeProjectionDb(
    capturedPredicates: Array<{ idx: number; pred: unknown }>,
    capturedJoins: Array<{ idx: number; pred: unknown }> = [],
  ) {
    let selectCount = 0;
    const chain = (idx: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ idx, pred });
        return { limit: jest.fn().mockResolvedValue([]) };
      }),
      innerJoin: jest.fn().mockImplementation((_table: unknown, on: unknown) => {
        capturedJoins.push({ idx, pred: on });
        return {
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
        };
      }),
    });
    return {
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const ci = selectCount;
        return { from: jest.fn().mockReturnValue(chain(ci)) };
      }),
    } as unknown as Db;
  }

  it("milestones WHERE predicate contains client_visible when canViewMilestones is true", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeProjectionDb(predicates);
    await buildPortalProjection(db, "org-1", 10, {
      canViewMilestones: true,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: false,
    });
    const milestoneEntry = predicates.find((e) => e.idx === 1);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("client_visible");
  });

  it("milestones WHERE predicate contains deleted_at when canViewMilestones is true", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const db = makeProjectionDb(predicates);
    await buildPortalProjection(db, "org-1", 10, {
      canViewMilestones: true,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: false,
    });
    const milestoneEntry = predicates.find((e) => e.idx === 1);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("deleted_at");
  });

  it("attachments JOIN ON predicate contains client_visible so parent-ticket visibility is enforced in the projection seam", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const joins: Array<{ idx: number; pred: unknown }> = [];
    const db = makeProjectionDb(predicates, joins);
    await buildPortalProjection(db, "org-1", 10, {
      canViewMilestones: false,
      canViewTasks: false,
      canViewAttachments: true,
      canViewComments: false,
    });
    const attachmentJoin = joins.find((e) => e.idx === 1);
    expect(attachmentJoin).toBeDefined();
    expect(renderSql(attachmentJoin!.pred)).toContain("client_visible");
  });

  it("comments JOIN ON predicate contains client_visible so parent-ticket visibility is enforced in the projection seam", async () => {
    const predicates: Array<{ idx: number; pred: unknown }> = [];
    const joins: Array<{ idx: number; pred: unknown }> = [];
    const db = makeProjectionDb(predicates, joins);
    await buildPortalProjection(db, "org-1", 10, {
      canViewMilestones: false,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: true,
    });
    const commentJoin = joins.find((e) => e.idx === 1);
    expect(commentJoin).toBeDefined();
    expect(renderSql(commentJoin!.pred)).toContain("client_visible");
  });

  it("returns empty arrays for all four collections when all capabilities are false (deny-by-default)", async () => {
    const db = makeProjectionDb([]);
    const result = await buildPortalProjection(db, "org-1", 10, {
      canViewMilestones: false,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: false,
    });
    expect(result.milestones).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.comments).toEqual([]);
    expect((db.select as jest.Mock).mock.calls).toHaveLength(0);
  });
});
