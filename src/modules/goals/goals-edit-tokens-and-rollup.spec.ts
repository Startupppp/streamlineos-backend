jest.mock("./goal-links.service");

import type { Db } from "../../db/drizzle.types";
import { GoalsService } from "./goals.service";
import { GoalLinksService } from "./goal-links.service";
import { AccessService } from "../access/access.service";
import { TicketVersionConflictException } from "../build/core";
import { createSchema, updateSchema } from "./dto/goal.schemas";
import { goalDetailSchema, goalRowSchema } from "./dto/goals-response.schemas";
import { rollUpKeyResultValues } from "./goals-key-result-rollup";
import { okrGoals } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-1";

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
    ownerMembershipId: null,
    level: "company",
    status: "on_track",
    progress: 50,
    confidence: 70,
    version: 4,
    startDate: null,
    dueDate: null,
    parentGoalId: null,
    projectId: null,
    createdByMembershipId: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeDb(options: {
  goalRows?: unknown[];
  rollupRows?: unknown[];
  keyResults?: unknown[];
  storedVersion?: number | null;
  updateReturnRows?: unknown[];
}) {
  const countChain = makeThenable([{ total: options.goalRows?.length ?? 0 }]);
  const rollupChain = makeThenable(options.rollupRows ?? []);
  const ownerChain = makeThenable([]);
  const select = jest.fn().mockImplementation((projection?: Record<string, unknown>) =>
    projection !== undefined && Object.keys(projection).length === 1 && "total" in projection
      ? countChain()
      : projection !== undefined && "membershipId" in projection
        ? ownerChain()
        : rollupChain(),
  );
  const set = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(options.updateReturnRows ?? []),
    }),
  });
  const update = jest.fn().mockReturnValue({ set });
  const findFirst = jest.fn().mockImplementation((args?: { columns?: Record<string, unknown> }) => {
    if (args?.columns !== undefined && "version" in args.columns) {
      return Promise.resolve(
        options.storedVersion === null || options.storedVersion === undefined
          ? undefined
          : { version: options.storedVersion },
      );
    }
    return Promise.resolve(options.goalRows?.[0] ?? null);
  });
  const insertValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([goalRow()]),
  });
  const insert = jest.fn().mockReturnValue({ values: insertValues });
  const db = {
    query: {
      okrGoals: { findMany: jest.fn().mockResolvedValue(options.goalRows ?? []), findFirst },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue(options.keyResults ?? []) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select,
    update,
    insert,
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert, update, select })),
  } as unknown as Db;
  return { db, update, set, select, insertValues };
}

function service(db: Db) {
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:view", "all"]])),
  } as unknown as AccessService;
  return new GoalsService(db, access, new GoalLinksService(db));
}

function userCtx(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
  };
}

describe("goal update concurrency token", () => {
  it("stale token returns 409 with currentVersion in details and never runs the update", async () => {
    const { db, update } = makeDb({ storedVersion: 9 });
    const error = await service(db)
      .update(ORG, 1, { version: 3, title: "renamed" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect((error as TicketVersionConflictException).getStatus()).toBe(409);
    expect((error as TicketVersionConflictException).getResponse()).toMatchObject({
      details: { currentVersion: 9 },
    });
    expect(update).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  it("matching token does not throw and runs the update query (BE-141 positive pair)", async () => {
    const { db, update } = makeDb({
      storedVersion: 9,
      goalRows: [goalRow({ version: 10 })],
      updateReturnRows: [{ id: 1 }],
    });
    const error = await service(db)
      .update(ORG, 1, { version: 9, title: "renamed" })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TicketVersionConflictException);
    expect(update).toHaveBeenCalled();
  });

  it("a goal that does not exist is a null miss, not a 409", async () => {
    const { db } = makeDb({ storedVersion: null });
    const result = await service(db).update(ORG, 1, { version: 1, title: "renamed" });
    expect(result).toBeNull();
  });

  it("a goal updated by a racer between the read and the write returns 409, not a silent no-op", async () => {
    const { db } = makeDb({ storedVersion: 9, updateReturnRows: [] });
    const error = await service(db)
      .update(ORG, 1, { version: 9, title: "renamed" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
  });

  it("does not let the caller's token overwrite the stored version column", async () => {
    const { db, set } = makeDb({
      storedVersion: 9,
      goalRows: [goalRow({ version: 10 })],
      updateReturnRows: [{ id: 1 }],
    });
    await service(db).update(ORG, 1, { version: 9, title: "renamed" });
    expect(set.mock.calls[0]?.[0]).not.toHaveProperty("version");
    expect(set.mock.calls[0]?.[0]).toHaveProperty("title", "renamed");
  });

  it("refuses an update with no concurrency token", () => {
    expect(updateSchema.safeParse({ title: "renamed" }).success).toBe(false);
    expect(updateSchema.safeParse({ version: 1, title: "renamed" }).success).toBe(true);
  });
});

describe("goal confidence", () => {
  it("has a column on okr_goals, so the field can exist at all", () => {
    expect(okrGoals.confidence.name).toBe("confidence");
  });

  it("survives the create schema and reaches the insert", async () => {
    const parsed = createSchema.parse({ title: "Goal A", confidence: 70 });
    expect(parsed.confidence).toBe(70);
    const { db, insertValues } = makeDb({});
    await service(db).create(ORG, "user-1", parsed, 1);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ confidence: 70 }));
  });

  it("writes null rather than dropping the column when the caller omits confidence", async () => {
    const { db, insertValues } = makeDb({});
    await service(db).create(ORG, "user-1", createSchema.parse({ title: "Goal A" }), 1);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ confidence: null }));
  });

  it("rejects a confidence outside 0..100 on create and update", () => {
    expect(createSchema.safeParse({ title: "G", confidence: 101 }).success).toBe(false);
    expect(createSchema.safeParse({ title: "G", confidence: -1 }).success).toBe(false);
    expect(updateSchema.safeParse({ version: 1, confidence: 101 }).success).toBe(false);
  });

  it("accepts the boundary values (BE-141 positive pair)", () => {
    expect(createSchema.safeParse({ title: "G", confidence: 0 }).success).toBe(true);
    expect(createSchema.safeParse({ title: "G", confidence: 100 }).success).toBe(true);
    expect(updateSchema.safeParse({ version: 1, confidence: 100 }).success).toBe(true);
  });

  it("can be cleared on update but not on create, because a goal starts with no judgement", () => {
    expect(updateSchema.safeParse({ version: 1, confidence: null }).success).toBe(true);
    expect(createSchema.safeParse({ title: "G", confidence: null }).success).toBe(false);
  });

  it("carries confidence and version through the row contract", () => {
    const parsed = goalRowSchema.parse(goalRow());
    expect(parsed.confidence).toBe(70);
    expect(parsed.version).toBe(4);
  });

  it("rejects a row contract that omits version, so the token cannot vanish on decode", () => {
    const withoutVersion: Record<string, unknown> = { ...goalRow() };
    delete withoutVersion.version;
    expect(goalRowSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("goal target and current are rolled up from key results", () => {
  it("sums the key-result target and current values", () => {
    expect(
      rollUpKeyResultValues([
        { targetValue: "100.00", currentValue: "25.50" },
        { targetValue: "200.00", currentValue: "74.50" },
      ]),
    ).toEqual({ target: "300.00", current: "100.00" });
  });

  it("returns null rather than zero for a goal with no key results, so no measure is not a target of zero", () => {
    expect(rollUpKeyResultValues([])).toEqual({ target: null, current: null });
  });

  it("does not lose a hundredth to floating point", () => {
    const rows = Array.from({ length: 3 }, () => ({ targetValue: "0.10", currentValue: "0.20" }));
    expect(rollUpKeyResultValues(rows)).toEqual({ target: "0.30", current: "0.60" });
  });

  it("projects target and current onto the list row from the key-result aggregate", async () => {
    const { db } = makeDb({
      goalRows: [goalRow()],
      rollupRows: [{ goalId: 1, total: 2, target: "300.00", current: "100.00" }],
    });
    const result = await service(db).list(userCtx(), { page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({ target: "300.00", current: "100.00", keyResultCount: 2 });
  });

  it("projects null target and current for a list row whose goal has no key results", async () => {
    const { db } = makeDb({ goalRows: [goalRow()], rollupRows: [] });
    const result = await service(db).list(userCtx(), { page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({ target: null, current: null, keyResultCount: 0 });
  });

  it("agrees between the list aggregate and the detail roll-up for the same key results", async () => {
    const keyResults = [
      { targetValue: "100.00", currentValue: "25.50" },
      { targetValue: "200.00", currentValue: "74.50" },
    ];
    const listDb = makeDb({
      goalRows: [goalRow()],
      rollupRows: [{ goalId: 1, total: 2, target: "300.00", current: "100.00" }],
    });
    const listed = await service(listDb.db).list(userCtx(), { page: 1, limit: 20 });
    const detailDb = makeDb({ goalRows: [goalRow()], keyResults });
    const detail = await service(detailDb.db).getGoal(ORG, 1);
    expect([detail?.target, detail?.current]).toEqual([
      listed.items[0]?.target,
      listed.items[0]?.current,
    ]);
  });

  it("carries target and current through the detail contract", () => {
    const parsed = goalDetailSchema.parse({
      ...goalRow(),
      target: "300.00",
      current: "100.00",
      owner: null,
      project: null,
      keyResults: [],
      updates: [],
      links: [],
    });
    expect([parsed.target, parsed.current]).toEqual(["300.00", "100.00"]);
  });

  it("rejects a detail contract that omits target, so the field cannot vanish on decode", () => {
    const payload: Record<string, unknown> = {
      ...goalRow(),
      current: "100.00",
      owner: null,
      project: null,
      keyResults: [],
      updates: [],
      links: [],
    };
    expect(goalDetailSchema.safeParse(payload).success).toBe(false);
  });

  it("adds no goal-level target or current column, so there is one source of truth", () => {
    const columns = Object.keys(okrGoals);
    expect(columns).not.toContain("target");
    expect(columns).not.toContain("current");
    expect(columns).not.toContain("targetValue");
    expect(columns).not.toContain("currentValue");
  });
});
