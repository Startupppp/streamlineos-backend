jest.mock("./goal-links.service");

import type { Db } from "../../db/drizzle.types";
import { GoalsService } from "./goals.service";
import { GoalLinksService } from "./goal-links.service";
import { AccessService } from "../access/access.service";
import { listSchema } from "./dto/goal.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-due-scope-health";

function makeThenable(resolved: unknown[]): jest.Mock {
  const fn = jest.fn();
  fn.mockImplementation(() => {
    const obj: Record<string, unknown> = {};
    for (const m of ["from", "where", "groupBy", "leftJoin", "innerJoin", "orderBy", "limit", "offset"]) {
      obj[m] = jest.fn(() => obj);
    }
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res);
    return obj;
  });
  return fn;
}

function goalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: ORG,
    title: "Goal A",
    description: null,
    ownerMembershipId: 10,
    level: "company",
    status: "not_started",
    progress: 20,
    confidence: null,
    version: 1,
    startDate: null,
    dueDate: "2026-01-01",
    parentGoalId: null,
    projectId: null,
    createdByMembershipId: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeDb(goalRows: unknown[]) {
  const countChain = makeThenable([{ total: goalRows.length }]);
  const rollupChain = makeThenable([]);
  const ownerChain = makeThenable([]);
  const findMany = jest.fn().mockResolvedValue(goalRows);
  const select = jest.fn().mockImplementation((projection?: Record<string, unknown>) =>
    projection !== undefined && Object.keys(projection).length === 1 && "total" in projection
      ? countChain()
      : projection !== undefined && "membershipId" in projection
        ? ownerChain()
        : rollupChain(),
  );
  const db = {
    query: {
      okrGoals: { findMany, findFirst: jest.fn() },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select,
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
  return { db, findMany };
}

function service(db: Db) {
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:manage", "all"]])),
  } as unknown as AccessService;
  return new GoalsService(db, access, new GoalLinksService(db));
}

function userCtx(membershipId = 10): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId, isOrgOwner: true },
  };
}

describe("listSchema accepts new filter fields (Tasks B, D, E)", () => {
  it("accepts a valid ISO due date — previously the strict schema would 400 this deep-link", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, due: "2026-12-31" }).success).toBe(true);
  });

  it("rejects a non-ISO due value so the field is validated not just passed through", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, due: "31/12/2026" }).success).toBe(false);
  });

  it("accepts own and all as scope values", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "own" }).success).toBe(true);
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "all" }).success).toBe(true);
  });

  it("rejects an unknown scope value so level aliases are not accidentally accepted", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "company" }).success).toBe(false);
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "team" }).success).toBe(false);
  });

  it("accepts the three health values that can be derived from existing columns", () => {
    for (const h of ["on_track", "at_risk", "off_track"] as const) {
      expect(listSchema.safeParse({ page: 1, limit: 20, health: h }).success).toBe(true);
    }
  });

  it("rejects not_started as a health value because health is derived, not declared", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, health: "not_started" }).success).toBe(false);
  });

  it("rejects completed as a health value for the same reason", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, health: "completed" }).success).toBe(false);
  });
});

describe("due filter narrows list results (Task B)", () => {
  it("calls findMany when a due filter is provided so the filter is not silently dropped", async () => {
    const { db, findMany } = makeDb([goalRow()]);
    await service(db).list(userCtx(), { page: 1, limit: 20, due: "2026-12-31" });
    expect(findMany).toHaveBeenCalled();
  });

  it("calls findMany with a where clause when due is set, not with undefined where", async () => {
    const { db, findMany } = makeDb([goalRow()]);
    await service(db).list(userCtx(), { page: 1, limit: 20, due: "2025-01-01" });
    const callArgs = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(callArgs?.where).toBeDefined();
  });
});

describe("scope filter (Task D)", () => {
  it("scope=own is accepted by the schema — previously would 400 from strict schema", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "own" }).success).toBe(true);
  });

  it("scope=own calls findMany (filter is not short-circuiting the query)", async () => {
    const { db, findMany } = makeDb([goalRow()]);
    await service(db).list(userCtx(10), { page: 1, limit: 20, scope: "own" });
    expect(findMany).toHaveBeenCalled();
  });

  it("scope is NOT an alias for level — company is rejected as a scope value", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, scope: "company" }).success).toBe(false);
  });

  it("level and scope are independent fields in the schema so both can be set simultaneously", () => {
    expect(
      listSchema.safeParse({ page: 1, limit: 20, level: "company", scope: "own" }).success,
    ).toBe(true);
  });
});

describe("health filter (Task E — derived from status, dueDate, progress)", () => {
  it("health filter is accepted by the schema — previously would 400 from strict schema", () => {
    expect(listSchema.safeParse({ page: 1, limit: 20, health: "at_risk" }).success).toBe(true);
  });

  it("health filter calls findMany with a where clause when provided", async () => {
    const { db, findMany } = makeDb([goalRow({ status: "at_risk" })]);
    await service(db).list(userCtx(), { page: 1, limit: 20, health: "at_risk" });
    const callArgs = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(callArgs?.where).toBeDefined();
  });

  it("off_track health filter calls findMany without short-circuiting", async () => {
    const { db, findMany } = makeDb([goalRow({ status: "off_track" })]);
    await service(db).list(userCtx(), { page: 1, limit: 20, health: "off_track" });
    expect(findMany).toHaveBeenCalled();
  });
});
