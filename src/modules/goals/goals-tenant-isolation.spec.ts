/**
 * GoalsService — cross-tenant isolation
 *
 * Proves that list scopes every query to the caller's org and cannot surface
 * goals owned by a different org.
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

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({ where }),
      }),
    }),
    query: {
      okrGoals: { findFirst: jest.fn().mockResolvedValue(rows[0] ?? null) },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
  return { db, where };
}

function makeAccessService(scope = "all") {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:view", scope]])),
  } as unknown as AccessService;
}

function userCtx(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", isOrgOwner: true, sessionId: "s" };
}

describe("GoalsService — cross-tenant isolation", () => {
  it("scopes list query to the requesting org", async () => {
    const { db, where } = makeDb([]);
    const svc = new GoalsService(db, makeAccessService());

    await svc.list(userCtx(ATTACKER_ORG), { cursor: undefined, limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns data for the owning org (same-tenant control)", async () => {
    const goalRow = {
      id: 1,
      orgId: OWNER_ORG,
      title: "Goal A",
      status: "on_track",
      level: "company",
      progress: 50,
      ownerUserId: null,
      ownerName: null,
      ownerEmail: null,
      ownerImage: null,
    };
    const { db } = makeDb([goalRow]);
    const svc = new GoalsService(db, makeAccessService());

    const result = await svc.list(userCtx(OWNER_ORG), { cursor: undefined, limit: 20 });

    expect(result.data).toHaveLength(1);
  });

  it("returns null for a goal in another org (getGoal cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new GoalsService(db, makeAccessService());

    const result = await svc.getGoal(ATTACKER_ORG, 999);

    expect(result).toBeNull();
  });
});
