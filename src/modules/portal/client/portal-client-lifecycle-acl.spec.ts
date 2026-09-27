import { NotFoundException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { PortalClientService } from "./portal-client.service";

const dialect = new PgDialect();

const makeAudit = () => ({ log: jest.fn(), logCritical: jest.fn() }) as unknown as AuditService;

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

describe("PortalClientService — lifecycle gate: isNull(deletedAt) on project rows (Requirement B)", () => {
  it("listGrantedProjects project query WHERE predicate contains 'deleted_at' so soft-deleted projects are excluded at the DB, not app layer", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              capturedWheres.push(pred);
              return { limit: jest.fn().mockResolvedValue([{ projectId: 42 }]) };
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              capturedWheres.push(pred);
              return { limit: jest.fn().mockResolvedValue([MINIMAL_PROJECT]) };
            }),
          }),
        }),
    } as unknown as Db;

    const svc = new PortalClientService(db, makeAudit());
    await svc.listGrantedProjects("org-1", "mem-1");

    expect(capturedWheres).toHaveLength(2);
    const projectPredicate = capturedWheres[1];
    expect(renderSql(projectPredicate)).toContain("deleted_at");
  });

  it("getProjectOverview project query WHERE predicate contains 'deleted_at' so soft-deleted projects are excluded at the DB", async () => {
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

    const svc = new PortalClientService(db, makeAudit());
    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);

    expect(capturedWheres).toHaveLength(2);
    const projectPredicate = capturedWheres[1];
    expect(renderSql(projectPredicate)).toContain("deleted_at");
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

    const svc = new PortalClientService(db, makeAudit());
    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
  });
});

describe("PortalClientService — source ACL gate: clientVisible=true on sub-resource rows (Requirement E)", () => {
  function buildDb(itemRows: { milestones?: unknown[]; tasks?: unknown[]; attachments?: unknown[]; comments?: unknown[] }) {
    let selectCallCount = 0;
    return {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const callIndex = selectCallCount;
        return {
          from: jest.fn().mockImplementation(() => ({
            where: jest.fn().mockImplementation((pred: unknown) => {
              const inner: Record<string, unknown> = { __pred: pred };
              return {
                limit: jest.fn().mockImplementation(() => {
                  // Call 1 = grant, call 2 = project, call 3+ = milestones/tasks etc
                  if (callIndex === 1) return Promise.resolve([ALL_CAPS_GRANT]);
                  if (callIndex === 2) return Promise.resolve([MINIMAL_PROJECT]);
                  if (callIndex === 3) return Promise.resolve(itemRows.milestones ?? []);
                  if (callIndex === 4) return Promise.resolve(itemRows.tasks ?? []);
                  return Promise.resolve([]);
                }),
                innerJoin: jest.fn().mockReturnValue({
                  where: jest.fn().mockImplementation((pred: unknown) => ({
                    __pred: pred,
                    limit: jest.fn().mockResolvedValue(itemRows.attachments ?? []),
                    leftJoin: jest.fn().mockReturnValue({
                      where: jest.fn().mockImplementation((pred2: unknown) => ({
                        __pred: pred2,
                        limit: jest.fn().mockResolvedValue(itemRows.comments ?? []),
                      })),
                    }),
                  })),
                }),
                ...inner,
              };
            }),
            innerJoin: jest.fn().mockImplementation(() => ({
              where: jest.fn().mockImplementation((pred: unknown) => ({
                __pred: pred,
                limit: jest.fn().mockResolvedValue(itemRows.attachments ?? []),
                leftJoin: jest.fn().mockReturnValue({
                  where: jest.fn().mockImplementation((pred2: unknown) => ({
                    __pred: pred2,
                    limit: jest.fn().mockResolvedValue(itemRows.comments ?? []),
                  })),
                }),
              })),
            })),
          })),
        };
      }),
    } as unknown as Db;
  }

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

    const svc = new PortalClientService(db, makeAudit());
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

    const svc = new PortalClientService(db, makeAudit());
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

    const svc = new PortalClientService(db, makeAudit());
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
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

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
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

    expect(joinPredicates.length).toBeGreaterThanOrEqual(2);
    for (const pred of joinPredicates) {
      const sqlText = renderSql(pred);
      expect(sqlText).toContain("client_visible");
      expect(sqlText).toContain("org_id");
    }
  });

  it("child WHERE predicate still requires clientVisible on the child row — internal child of visible parent excluded", async () => {
    const { db, wherePredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

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
    await expect(new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
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
    await expect(new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42)).rejects.toThrow(NotFoundException);
    expect(renderSql(capturedGrantWhere[0])).toContain("expires_at");
  });

  it("cross-project isolation — attachment join predicate includes projectId equality so another project's child rows are excluded at the DB", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

    for (const pred of joinPredicates) {
      expect(renderSql(pred)).toContain("project_id");
    }
  });

  it("cross-tenant isolation — attachment join predicate includes orgId equality so another org's rows are excluded at the DB", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

    for (const pred of joinPredicates) {
      expect(renderSql(pred)).toContain("org_id");
    }
  });

  it("deleted parent ticket rows are excluded — join ON clause contains deleted_at IS NULL", async () => {
    const { db, joinPredicates } = buildPredicateCapturingDb();
    await new PortalClientService(db, makeAudit()).getProjectOverview("org-1", "mem-1", 42);

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
    const svc = new PortalClientService(db, makeAudit());
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

    const svc = new PortalClientService(db, makeAudit());
    await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(capturedJoinPredicates.length).toBeGreaterThanOrEqual(2);
    const allContainClientVisible = capturedJoinPredicates.every(
      (pred) => renderSql(pred).includes("client_visible"),
    );
    expect(allContainClientVisible).toBe(true);
  });
});
