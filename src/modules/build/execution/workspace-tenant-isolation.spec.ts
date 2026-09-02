import type { Db } from "../../../db/drizzle.module";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { MilestonesService, IntakeService, ViewsService } from "./workspace.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeUser(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

function makeAccess(permissions: string[]): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(permissions)),
  } as unknown as AccessService;
}

function membershipSelect(rows: unknown[][]): jest.Mock {
  let call = 0;
  return jest.fn(() => {
    const index = call;
    call++;
    const chain: Record<string, unknown> = {};
    chain["from"] = jest.fn(() => chain);
    chain["innerJoin"] = jest.fn(() => chain);
    chain["where"] = jest.fn(() => chain);
    chain["limit"] = jest.fn(() => Promise.resolve(rows[index] ?? []));
    return chain;
  });
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

describe("MilestonesService — cross-tenant isolation", () => {
  it("listMilestones scopes findMany WHERE to requesting org (cross-tenant isolation)", async () => {
    const projectFindFirst = jest.fn().mockResolvedValue({ id: 1 });
    const milestoneFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        projects: { findFirst: projectFindFirst },
        projectMilestones: { findMany: milestoneFindMany },
      },
    } as unknown as Db;
    const svc = new MilestonesService(db, makeAccess(["build:manage"]));

    const result = await svc.listMilestones(makeUser(ATTACKER_ORG), 1);

    expect(milestoneFindMany).toHaveBeenCalled();
    const opts = milestoneFindMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(opts?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(opts?.where)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listMilestones returns milestones for the owning org (control — same-tenant access works)", async () => {
    const fakeMilestone = { id: 1, orgId: OWNER_ORG, name: "M1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([fakeMilestone]) },
      },
    } as unknown as Db;
    const svc = new MilestonesService(db, makeAccess(["build:manage"]));

    const result = await svc.listMilestones(makeUser(OWNER_ORG), 1);
    expect(result).toHaveLength(1);
  });

  it("listMilestones throws NotFoundException when project not found for attacker org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new MilestonesService(db, makeAccess(["build:manage"]));

    await expect(svc.listMilestones(makeUser(ATTACKER_ORG), 9999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("denies a same-org non-member without build:manage (project membership gate)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: membershipSelect([[], []]),
    } as unknown as Db;
    const svc = new MilestonesService(db, makeAccess(["build:view"]));

    await expect(svc.listMilestones(makeUser(OWNER_ORG), 1)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("allows a direct project member without build:manage", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectMilestones: { findMany: jest.fn().mockResolvedValue([{ id: 1 }]) },
      },
      select: membershipSelect([[{ role: "MEMBER" }], []]),
    } as unknown as Db;
    const svc = new MilestonesService(db, makeAccess(["build:view"]));

    await expect(svc.listMilestones(makeUser(OWNER_ORG), 1)).resolves.toHaveLength(1);
  });
});

describe("IntakeService — cross-tenant isolation", () => {
  it("listIntake scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new IntakeService(db);

    const result = await svc.listIntake(ATTACKER_ORG, 1, { limit: 10 } as never);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result.items).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("listIntake returns items for the owning org (control — same-tenant access works)", async () => {
    const fakeItem = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "req", description: null, source: "manual", status: "pending", submitterEmail: null, submitterName: null, priority: null, requestType: null, linkedWorkItemId: null, declineReason: null, createdAt: new Date(), updatedAt: new Date() };
    const db = {
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
    expect(result.items).toHaveLength(1);
    expect(result.pagination.hasMore).toBe(false);
  });
});

describe("ViewsService — cross-tenant isolation", () => {
  it("listViews scopes WHERE to requesting org (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ViewsService(db);

    const result = await svc.listViews(ATTACKER_ORG, "u1", 1);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listViews returns views for the owning org (control — same-tenant access works)", async () => {
    const fakeView = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "All Issues" };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeView]) }) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ViewsService(db);

    const result = await svc.listViews(OWNER_ORG, "u1", 1);
    expect(result).toHaveLength(1);
  });
});
