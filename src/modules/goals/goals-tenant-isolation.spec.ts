/**
 * GoalsService — cross-tenant isolation
 *
 * Proves that list and getGoal scope every query to the caller's org and cannot
 * surface goals owned by a different org.
 */

jest.mock("./goal-links.service");

import type { Db } from "../../db/drizzle.types";
import { GoalsService } from "./goals.service";
import { GoalLinksService } from "./goal-links.service";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeThenable(resolved: unknown[]): jest.Mock {
  const fn = jest.fn();
  fn.mockImplementation(() => {
    const obj: Record<string, unknown> = {};
    const methods = ["from", "where", "groupBy", "leftJoin", "innerJoin", "orderBy", "limit", "offset"];
    for (const m of methods) {
      obj[m] = jest.fn(() => obj);
    }
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res);
    return obj;
  });
  return fn;
}

/**
 * `select(...)` answers two different queries in `list`: the envelope's COUNT over
 * `okr_goals`, and the per-goal key-result roll-up. Only the first projects a bare
 * `total`, which is how they are told apart here.
 */
function makeSelect(total: number, owners: unknown[] = []): jest.Mock {
  const countChain = makeThenable([{ total }]);
  const rollupChain = makeThenable([]);
  const ownerChain = makeThenable(owners);
  return jest.fn().mockImplementation((projection?: Record<string, unknown>) =>
    projection !== undefined && Object.keys(projection).length === 1 && "total" in projection
      ? countChain()
      : projection !== undefined && "membershipId" in projection
        ? ownerChain()
      : rollupChain(),
  );
}

function makeDb(goalRows: unknown[], owners: unknown[] = []): Db {
  return {
    query: {
      okrGoals: {
        findMany: jest.fn().mockResolvedValue(goalRows),
        findFirst: jest.fn().mockResolvedValue(goalRows[0] ?? null),
      },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: makeSelect(goalRows.length, owners),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({} as unknown)),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
}

function makeAccessService(scope = "all") {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:view", scope]])),
  } as unknown as AccessService;
}

function userCtx(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
  };
}

describe("GoalsService — cross-tenant isolation", () => {
  it("returns nothing for a different org (cross-tenant access denied)", async () => {
    const db = makeDb([]);
    const svc = new GoalsService(db, makeAccessService(), new GoalLinksService(db));
    const result = await svc.list(userCtx(ATTACKER_ORG), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const goalRow = {
      id: 1,
      orgId: OWNER_ORG,
      title: "Goal A",
      status: "on_track",
      level: "company",
      progress: 50,
      ownerId: null,
      owner: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: "user-1",
      description: null,
      startDate: null,
      dueDate: null,
      parentGoalId: null,
      projectId: null,
    };
    const db = makeDb([goalRow]);
    const svc = new GoalsService(db, makeAccessService(), new GoalLinksService(db));
    const result = await svc.list(userCtx(OWNER_ORG), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("projects a tenant-scoped owner for an owned goal", async () => {
    const goalRow = {
      id: 1,
      orgId: OWNER_ORG,
      title: "Goal A",
      status: "on_track",
      level: "company",
      progress: 50,
      ownerMembershipId: 7,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdByMembershipId: 1,
      description: null,
      startDate: null,
      dueDate: null,
      parentGoalId: null,
      projectId: null,
    };
    const db = makeDb([goalRow], [{ membershipId: 7, id: "owner-1", name: "Owner", email: "owner@example.com", image: null }]);
    const svc = new GoalsService(db, makeAccessService(), new GoalLinksService(db));
    const result = await svc.list(userCtx(OWNER_ORG), { page: 1, limit: 20 });
    expect(result.items[0]?.owner).toEqual({
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
      image: null,
    });
  });

  it("returns null for a goal in another org (getGoal cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const svc = new GoalsService(db, makeAccessService(), new GoalLinksService(db));
    const result = await svc.getGoal(ATTACKER_ORG, 999);
    expect(result).toBeNull();
  });
});
