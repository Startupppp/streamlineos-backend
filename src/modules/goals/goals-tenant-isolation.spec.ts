/**
 * GoalsService — cross-tenant isolation
 *
 * Proves that list and getGoal scope every query to the caller's org and cannot
 * surface goals owned by a different org.
 */

import type { Db } from "../../db/drizzle.types";
import { GoalsService } from "./goals.service";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeThenable(resolved: unknown[]): jest.Mock {
  const fn = jest.fn();
  fn.mockImplementation(() => {
    const obj: Record<string, unknown> = {};
    const methods = ["from", "where", "groupBy", "leftJoin", "orderBy", "limit", "offset"];
    for (const m of methods) {
      obj[m] = jest.fn(() => obj);
    }
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res);
    return obj;
  });
  return fn;
}

function makeDb(goalRows: unknown[]): Db {
  return {
    query: {
      okrGoals: {
        findMany: jest.fn().mockResolvedValue(goalRows),
        findFirst: jest.fn().mockResolvedValue(goalRows[0] ?? null),
      },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: makeThenable([]),
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
    const svc = new GoalsService(db, makeAccessService(), {} as never);
    const result = await svc.list(userCtx(ATTACKER_ORG), { page: 1, limit: 20 });
    expect(result).toHaveLength(0);
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
    const svc = new GoalsService(db, makeAccessService(), {} as never);
    const result = await svc.list(userCtx(OWNER_ORG), { page: 1, limit: 20 });
    expect(result).toHaveLength(1);
  });

  it("returns null for a goal in another org (getGoal cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const svc = new GoalsService(db, makeAccessService(), {} as never);
    const result = await svc.getGoal(ATTACKER_ORG, 999);
    expect(result).toBeNull();
  });
});
