import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { listMilestonesQuerySchema } from "./dto/workspace.schemas";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MilestonesService, IntakeService, ViewsService } from "./workspace.service";

const EMPTY_MILESTONES_QUERY = listMilestonesQuerySchema.parse({});

interface MilestoneSelectChain {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function milestoneSelectChain(rows: unknown[]) {
  const whereSpy = jest.fn();
  const chain: MilestoneSelectChain = {
    from: jest.fn(() => chain),
    where: jest.fn((condition: unknown) => {
      whereSpy(condition);
      return chain;
    }),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  return { chain, whereSpy };
}

function memberSelectChain(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
    }),
  };
}

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
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

const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

beforeEach(() => {
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("MilestonesService — cross-tenant isolation", () => {
  it("listMilestones scopes the select WHERE to requesting org (cross-tenant isolation)", async () => {
    const { chain, whereSpy } = milestoneSelectChain([]);
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 999 }) } },
      select: jest
        .fn()
        .mockReturnValueOnce(memberSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        })
        .mockReturnValue(chain),
    } as unknown as Db;
    const svc = new MilestonesService(db, mockAccess);

    const result = await svc.listMilestones(makeU(ATTACKER_ORG), 1, EMPTY_MILESTONES_QUERY);

    expect(whereSpy).toHaveBeenCalled();
    const condition = whereSpy.mock.calls[0]?.[0];
    expect(sqlValues(condition)).toContain(ATTACKER_ORG);
    expect(sqlValues(condition)).not.toContain(OWNER_ORG);
    expect(result.data).toHaveLength(0);
  });

  it("listMilestones returns milestones for the owning org (control — same-tenant access works)", async () => {
    const fakeMilestone = { id: 1, orgId: OWNER_ORG, name: "M1", targetDate: "2026-01-01" };
    const { chain } = milestoneSelectChain([fakeMilestone]);
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 999 }) } },
      select: jest.fn().mockReturnValue(chain),
    } as unknown as Db;
    const svc = new MilestonesService(db, mockAccess);

    const result = await svc.listMilestones(makeU(OWNER_ORG, true), 1, EMPTY_MILESTONES_QUERY);
    expect(result.data).toHaveLength(1);
  });

  it("listMilestones throws NotFoundException when project not found for attacker org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn(),
    } as unknown as Db;
    const svc = new MilestonesService(db, mockAccess);

    await expect(svc.listMilestones(makeU(ATTACKER_ORG), 9999, EMPTY_MILESTONES_QUERY)).rejects.toThrow(NotFoundException);
  });
});

describe("MilestonesService — project membership gate (BOLA fix)", () => {
  const ORG = "org-1";
  const u = makeU(ORG);
  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeNonMemberDb(): Db {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
    } as unknown as Db;
  }

  function makeMemberDb(): Db {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest
        .fn()
        .mockReturnValueOnce(memberSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        })
        .mockReturnValue(milestoneSelectChain([]).chain),
    } as unknown as Db;
  }

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("rejects non-member with ForbiddenException on listMilestones", async () => {
    const db = makeNonMemberDb();
    const svc = new MilestonesService(db, gateAccess);
    await expect(svc.listMilestones(u, 1, EMPTY_MILESTONES_QUERY)).rejects.toThrow(ForbiddenException);
  });

  it("allows direct project member on listMilestones", async () => {
    const db = makeMemberDb();
    const svc = new MilestonesService(db, gateAccess);
    await expect(svc.listMilestones(u, 1, EMPTY_MILESTONES_QUERY)).resolves.toBeDefined();
  });
});

describe("IntakeService — cross-tenant isolation", () => {
  it("listIntake refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new IntakeService(db);

    await expect(svc.listIntake(ATTACKER_ORG, 1, { limit: 10 } as never)).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listIntake returns data for the owning org (control — same-tenant access works)", async () => {
    const fakeItem = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "req", description: null, source: "manual", status: "pending", submitterEmail: null, submitterName: null, priority: null, requestType: null, linkedWorkItemId: null, declineReason: null, createdAt: new Date(), updatedAt: new Date() };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([fakeItem]),
            }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new IntakeService(db);

    const result = await svc.listIntake(OWNER_ORG, 1, { limit: 10 } as never);
    expect(result).not.toHaveProperty("items");
    expect(result.data).toHaveLength(1);
    expect(result.pagination.hasMore).toBe(false);
  });
});

describe("ViewsService — cross-tenant isolation", () => {
  it("listViews refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ViewsService(db);

    await expect(svc.listViews(ATTACKER_ORG, "u1", 1)).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listViews returns views for the owning org (control — same-tenant access works)", async () => {
    const fakeView = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "All Issues" };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeView]) }) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ViewsService(db);

    const result = await svc.listViews(OWNER_ORG, "u1", 1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.orgId).toBe(OWNER_ORG);
  });
});

describe("ViewsService — a private view belongs to one actor, not to the tenant", () => {
  function mutationDb(existing: unknown) {
    const returning = jest.fn().mockResolvedValue([{ id: 7 }]);
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    });
    const del = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    const findFirst = jest.fn().mockResolvedValue(existing);
    const db = {
      query: { projectViews: { findFirst } },
      update,
      delete: del,
    } as unknown as Db;
    return { db, update, delete: del, findFirst };
  }

  const OTHERS_PRIVATE = { id: 7, createdBy: "u2", visibility: "private" };
  const OTHERS_SHARED = { id: 7, createdBy: "u2", visibility: "shared" };
  const OWN_PRIVATE = { id: 7, createdBy: "u1", visibility: "private" };

  it("listViews narrows the WHERE to the caller so another actor's private view is never a candidate row", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;

    await new ViewsService(db).listViews(OWNER_ORG, "u1", 1);

    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain("u1");
    expect(sqlValues(predicate)).not.toContain("u2");
  });

  it("updateView refuses another actor's private view with 403, not 404, because the caller is inside the right tenant", async () => {
    const { db, update } = mutationDb(OTHERS_PRIVATE);

    await expect(new ViewsService(db).updateView(OWNER_ORG, "u1", 1, 7, { name: "x" })).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("deleteView refuses another actor's private view and issues no DELETE", async () => {
    const { db, delete: del } = mutationDb(OTHERS_PRIVATE);

    await expect(new ViewsService(db).deleteView(OWNER_ORG, "u1", 1, 7)).rejects.toThrow(ForbiddenException);
    expect(del).not.toHaveBeenCalled();
  });

  it("updateWorkspaceView refuses another actor's private workspace view", async () => {
    const { db, update } = mutationDb(OTHERS_PRIVATE);

    await expect(new ViewsService(db).updateWorkspaceView(OWNER_ORG, "u1", 7, { name: "x" })).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("deleteWorkspaceView refuses another actor's private workspace view", async () => {
    const { db, delete: del } = mutationDb(OTHERS_PRIVATE);

    await expect(new ViewsService(db).deleteWorkspaceView(OWNER_ORG, "u1", 7)).rejects.toThrow(ForbiddenException);
    expect(del).not.toHaveBeenCalled();
  });

  it("updateView still allows a SHARED view owned by someone else, so the guard gates privacy rather than authorship", async () => {
    const { db, update } = mutationDb(OTHERS_SHARED);

    await expect(new ViewsService(db).updateView(OWNER_ORG, "u1", 1, 7, { name: "x" })).resolves.toEqual({ id: 7 });
    expect(update).toHaveBeenCalled();
  });

  it("updateView still allows the owner to edit their own private view", async () => {
    const { db, update } = mutationDb(OWN_PRIVATE);

    await expect(new ViewsService(db).updateView(OWNER_ORG, "u1", 1, 7, { name: "x" })).resolves.toEqual({ id: 7 });
    expect(update).toHaveBeenCalled();
  });

  it("updateView reports a view absent from the tenant as 404, keeping cross-tenant ids from becoming an existence oracle", async () => {
    const { db } = mutationDb(undefined);

    await expect(new ViewsService(db).updateView(ATTACKER_ORG, "u1", 1, 7, { name: "x" })).rejects.toThrow(NotFoundException);
  });
});
