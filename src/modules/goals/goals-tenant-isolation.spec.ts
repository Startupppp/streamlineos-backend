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

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeQueryDb(rows: unknown[]) {
  const fullChain = {
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockResolvedValue([]),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const selectMock = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue(fullChain),
  });

  const db = {
    query: {
      okrGoals: {
        findMany: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
      },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: selectMock,
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({} as unknown)),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
  const findMany = (db.query as { okrGoals: { findMany: jest.Mock } }).okrGoals.findMany;
  return { db, findMany };
}

function makeAccessService(scope = "all") {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:view", scope]])),
  } as unknown as AccessService;
}

function userCtx(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", isOrgOwner: true, sessionId: "s", memberId: "m" };
}

describe("GoalsService — cross-tenant isolation", () => {
  it("returns nothing for a different org (cross-tenant access denied)", async () => {
    const { db, findMany } = makeQueryDb([]);
    const svc = new GoalsService(db, makeAccessService());

    const result = await svc.list(userCtx(ATTACKER_ORG), { page: 1, limit: 20 });

    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const findManyCall = findMany.mock.calls[0]?.[0];
    const whereArg = findManyCall?.where;
    expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const goalRow = {
      id: 1,
      orgId: OWNER_ORG,
      title: "Goal A",
      status: "on_track",
      level: "company",
      progress: 50,
      owner: null,
    };
    const { db } = makeQueryDb([goalRow]);
    const svc = new GoalsService(db, makeAccessService());

    const result = await svc.list(userCtx(OWNER_ORG), { page: 1, limit: 20 });

    expect(result).toHaveLength(1);
  });

  it("returns null for a goal in another org (getGoal cross-tenant isolation)", async () => {
    const { db } = makeQueryDb([]);
    const svc = new GoalsService(db, makeAccessService());

    const result = await svc.getGoal(ATTACKER_ORG, 999);

    expect(result).toBeNull();
  });
});
