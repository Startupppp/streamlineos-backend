import { NotFoundException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { PortalClientService } from "./portal-client.service";
import { PortalProjectionService } from "../../build/client-portal/portal-projection.service";
import { projectClientGrants, projects } from "../../../db/schema";

const dialect = new PgDialect();

const makeAudit = () => ({ log: jest.fn(), logCritical: jest.fn() }) as unknown as AuditService;
const makeProjection = (db: Db) => new PortalProjectionService(db as never);

function renderSql(predicate: unknown): string {
  if (!is(predicate, SQL)) return "";
  return dialect.sqlToQuery(predicate).sql;
}

const ALL_CAPS_GRANT = {
  projectClientGrantId: "grant-1",
  organizationId: "org-1",
  portalMembershipId: "mem-1",
  projectId: 42,
  status: "ACTIVE",
  expiresAt: null,
  canViewMilestones: true,
  canViewTasks: true,
  canViewAttachments: true,
  canViewComments: true,
  canSubmitChangeRequests: true,
};

const MINIMAL_PROJECT = {
  id: 42,
  name: "Alpha",
  key: "A",
  status: "active",
  startDate: null,
  targetEndDate: null,
};

describe("PortalClientService — lifecycle gate: published, non-deleted project rows (Requirement B)", () => {
  it("listGrantedProjects project query excludes soft-deleted and unpublished projects at the DB", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedWheres.push(pred);
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([MINIMAL_PROJECT]),
              }),
            };
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.listGrantedProjects("org-1", "mem-1");

    expect(capturedWheres).toHaveLength(1);
    const projectPredicate = capturedWheres[0];
    const projectSql = renderSql(projectPredicate);
    expect(projectSql).toContain("deleted_at");
    expect(projectSql).toContain("portal_published_at");
    expect(projectSql).toContain("is not null");
    expect(projectSql).toContain("portal_membership_id");
    expect(projectSql).toContain("expires_at");
  });

  it("applies the limit after effective visibility so a published project remains visible beyond 100 hidden grants", async () => {
    const hiddenGrants = Array.from({ length: 101 }, (_, index) => ({
      projectId: index + 1,
      published: false,
    }));
    const visibleProject = { ...MINIMAL_PROJECT, id: 1000 };
    const grants = [...hiddenGrants, { projectId: visibleProject.id, published: true }];
    let prelimitedProjectIds: Set<number> | null = null;

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockImplementation((table: unknown) => {
          if (table === projectClientGrants) {
            return {
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockImplementation((limit: number) => {
                  prelimitedProjectIds = new Set(grants.slice(0, limit).map((grant) => grant.projectId));
                  return grants.slice(0, limit);
                }),
              }),
            };
          }
          expect(table).toBe(projects);
          const rows =
            prelimitedProjectIds === null || prelimitedProjectIds.has(visibleProject.id)
              ? [visibleProject]
              : [];
          return {
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
            }),
          };
        }),
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.listGrantedProjects("org-1", "mem-1")).resolves.toEqual([
      visibleProject,
    ]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("getProjectOverview requires a same-org active grant whose project exists, is not deleted, and is published", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              capturedWheres.push(pred);
              return { limit: jest.fn().mockResolvedValue([ALL_CAPS_GRANT]) };
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              capturedWheres.push(pred);
              return { limit: jest.fn().mockResolvedValue([]) };
            }),
          }),
        }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);

    expect(capturedWheres).toHaveLength(2);
    const grantPredicate = capturedWheres[0];
    const projectPredicate = capturedWheres[1];
    const grantSql = renderSql(grantPredicate).toLowerCase();
    const projectSql = renderSql(projectPredicate).toLowerCase();
    expect(grantSql).toContain("exists");
    expect(grantSql).toContain("organization_id");
    expect(grantSql).toContain("project_id");
    expect(grantSql).toContain("deleted_at");
    expect(grantSql).toContain("portal_published_at");
    expect(projectSql).toContain("deleted_at");
    expect(projectSql).toContain("portal_published_at");
    expect(projectSql).toContain("is not null");
  });

  it("getProjectOverview throws NotFoundException when project SELECT returns empty — mirrors the DB excluding a soft-deleted record", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([ALL_CAPS_GRANT]) }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
  });

  it("getProjectOverview returns the same safe NotFoundException after a project is unpublished", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toMatchObject({
      message: "Project not found",
    });
  });
});

describe("PortalClientService — source ACL gate: clientVisible=true on sub-resource rows (Requirement E)", () => {
  it("milestones WHERE predicate contains 'client_visible' so internal milestones not flagged for portal are excluded at the DB", async () => {
    const capturedPredicates: Array<{ callIndex: number; pred: unknown }> = [];
    let selectCallCount = 0;

    // Attachments: select().from().innerJoin().where().limit()
    // Comments:   select().from().innerJoin().leftJoin().where().limit()
    const stubFromChain = (callIndex: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ callIndex, pred });
        return {
          limit: jest.fn().mockImplementation(() => {
            if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
            if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
            return Promise.resolve([]);
          }),
        };
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: unknown) => {
          capturedPredicates.push({ callIndex, pred });
          return { limit: jest.fn().mockResolvedValue([]) };
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedPredicates.push({ callIndex, pred });
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const ci = selectCallCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.getProjectOverview("org-1", "mem-1", 42);

    const milestoneEntry = capturedPredicates.find((e) => e.callIndex === 3);
    expect(milestoneEntry).toBeDefined();
    expect(renderSql(milestoneEntry!.pred)).toContain("client_visible");
  });

  it("tasks WHERE predicate contains 'client_visible' so internal tickets not flagged for portal are excluded at the DB", async () => {
    const capturedPredicates: Array<{ callIndex: number; pred: unknown }> = [];
    let selectCallCount = 0;

    const stubFromChain = (callIndex: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        capturedPredicates.push({ callIndex, pred });
        return {
          limit: jest.fn().mockImplementation(() => {
            if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
            if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
            return Promise.resolve([]);
          }),
        };
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: unknown) => {
          capturedPredicates.push({ callIndex, pred });
          return { limit: jest.fn().mockResolvedValue([]) };
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedPredicates.push({ callIndex, pred });
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const ci = selectCallCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.getProjectOverview("org-1", "mem-1", 42);

    const taskEntry = capturedPredicates.find((e) => e.callIndex === 4);
    expect(taskEntry).toBeDefined();
    expect(renderSql(taskEntry!.pred)).toContain("client_visible");
  });

  it("a grant with all capabilities false returns empty arrays for all sub-resources — deny by default without clientVisible check needed", async () => {
    const NO_CAP_GRANT = { ...ALL_CAPS_GRANT, canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false };
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([NO_CAP_GRANT]) }) }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MINIMAL_PROJECT]) }) }),
        }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    const result = await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(result.milestones).toHaveLength(0);
    expect(result.tasks).toHaveLength(0);
    expect(result.attachments).toHaveLength(0);
    expect(result.comments).toHaveLength(0);
  });
});

describe("PortalClientService — table-driven visibility matrix: parent × child clientVisible, deleted records, revoked grants, cross-project/cross-tenant (Requirement F full coverage)", () => {
  function buildPredicateCapturingDb(): { db: Db; joinPredicates: unknown[]; wherePredicates: Array<{ callIndex: number; pred: unknown }> } {
    const joinPredicates: unknown[] = [];
    const wherePredicates: Array<{ callIndex: number; pred: unknown }> = [];
    let selectCallCount = 0;

    const stubFromChain = (callIndex: number) => ({
      where: jest.fn().mockImplementation((pred: unknown) => {
        wherePredicates.push({ callIndex, pred });
        return {
          limit: jest.fn().mockImplementation(() => {
            if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
            if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
            return Promise.resolve([]);
          }),
        };
      }),
      innerJoin: jest.fn().mockImplementation((_table: unknown, joinPred: unknown) => {
        joinPredicates.push(joinPred);
        return {
          where: jest.fn().mockImplementation((pred: unknown) => {
            wherePredicates.push({ callIndex, pred });
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              wherePredicates.push({ callIndex, pred });
              return { limit: jest.fn().mockResolvedValue([]) };
            }),
          }),
        };
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const ci = selectCallCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      }),
    } as unknown as Db;

    return { db, joinPredicates, wherePredicates };
  }

  it("attachment join ON clause requires both parent clientVisible and child-table join fields (parent × child matrix: both must be present)", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    const attachmentJoin = joinPredicates.find((p) => {
      const sql = renderSql(p);
      return sql.includes("ticket_attachments") || sql.includes("ticket_id") || sql.includes("client_visible");
    }) ?? joinPredicates[0];
    const sqlText = renderSql(attachmentJoin);
    expect(sqlText).toContain("client_visible");
    expect(sqlText).toContain("project_id");
    expect(sqlText).toContain("org_id");
    expect(sqlText).toContain("deleted_at");
  });

  it("comment join ON clause requires both parent clientVisible and child-table join fields", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    expect(joinPredicates.length).toBeGreaterThanOrEqual(2);
    for (const pred of joinPredicates) {
      const sqlText = renderSql(pred);
      expect(sqlText).toContain("client_visible");
      expect(sqlText).toContain("org_id");
    }
  });

  it("child WHERE predicate still requires clientVisible on the child row — internal child of visible parent excluded", async () => {
    const { db, wherePredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    const childPredicates = wherePredicates.filter(({ callIndex }: { callIndex: number; pred: unknown }) => callIndex > 2) as Array<{ callIndex: number; pred: unknown }>;
    const childClientVisiblePreds = childPredicates.filter(({ pred }) => renderSql(pred).includes("client_visible"));
    expect(childClientVisiblePreds.length).toBeGreaterThanOrEqual(2);
  });

  it("no active grant found causes NotFoundException — simulates DB applying the status=ACTIVE predicate and finding nothing", async () => {
    const capturedGrantWhere: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedGrantWhere.push(pred);
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    } as unknown as Db;
    await expect(new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
    expect(renderSql(capturedGrantWhere[0])).toContain("status");
  });

  it("expired grant (expiresAt in the past) is excluded — the grant WHERE predicate contains expiresAt check", async () => {
    const capturedGrantWhere: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            capturedGrantWhere.push(pred);
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    } as unknown as Db;
    await expect(new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
    expect(renderSql(capturedGrantWhere[0])).toContain("expires_at");
  });

  it("cross-project isolation — attachment join predicate includes projectId equality so another project's child rows are excluded at the DB", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    for (const pred of joinPredicates) {
      expect(renderSql(pred)).toContain("project_id");
    }
  });

  it("cross-tenant isolation — attachment join predicate includes orgId equality so another org's rows are excluded at the DB", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    for (const pred of joinPredicates) {
      expect(renderSql(pred)).toContain("org_id");
    }
  });

  it("deleted parent ticket rows are excluded — join ON clause contains deleted_at IS NULL", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit(), makeProjection(db)).getProjectOverview("org-1", "mem-1", 42);

    for (const pred of joinPredicates) {
      expect(renderSql(pred)).toContain("deleted_at");
    }
  });
});

describe("PortalClientService — parent ticket clientVisible required on attachment and comment joins (Requirement F)", () => {
  function buildCapturingDb() {
    const capturedJoinPredicates: unknown[] = [];
    let selectCallCount = 0;

    const stubFromChain = (callIndex: number) => ({
      where: jest.fn().mockImplementation(() => ({
        limit: jest.fn().mockImplementation(() => {
          if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
          if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
          return Promise.resolve([]);
        }),
      })),
      innerJoin: jest.fn().mockImplementation((_table: unknown, pred: unknown) => {
        capturedJoinPredicates.push(pred);
        return {
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        };
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const ci = selectCallCount;
        return { from: jest.fn().mockReturnValue(stubFromChain(ci)) };
      }),
    } as unknown as Db;

    return { db, capturedJoinPredicates };
  }

  it("every innerJoin on a ticket child table includes 'client_visible' in the ON clause so a child of an internal-only ticket is excluded at the DB", async () => {
    const { db, capturedJoinPredicates } = buildCapturingDb();
    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(capturedJoinPredicates.length).toBeGreaterThanOrEqual(2);
    for (const pred of capturedJoinPredicates) {
      expect(renderSql(pred)).toContain("client_visible");
    }
  });

  it("removing 'client_visible' from the join predicate causes the test to fail — guard against regression", async () => {
    const capturedJoinPredicates: unknown[] = [];
    let selectCallCount = 0;

    const brokenFromChain = (callIndex: number) => ({
      where: jest.fn().mockImplementation(() => ({
        limit: jest.fn().mockImplementation(() => {
          if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
          if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
          return Promise.resolve([]);
        }),
      })),
      innerJoin: jest.fn().mockImplementation((_table: unknown, pred: unknown) => {
        capturedJoinPredicates.push(pred);
        return {
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        };
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const ci = selectCallCount;
        return { from: jest.fn().mockReturnValue(brokenFromChain(ci)) };
      }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit(), makeProjection(db));
    await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(capturedJoinPredicates.length).toBeGreaterThanOrEqual(2);
    const allContainClientVisible = capturedJoinPredicates.every(
      (pred) => renderSql(pred).includes("client_visible"),
    );
    expect(allContainClientVisible).toBe(true);
  });
});
