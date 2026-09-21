import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ExitWriteService } from "./exit-write.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(), for: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.for.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allQueryArgs(findFirst: jest.Mock, where: jest.Mock): unknown[] {
  const ff = findFirst.mock.calls.flatMap((call) =>
    sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
  );
  const wh = where.mock.calls.flatMap((call) => sqlValues(call[0]));
  return [...ff, ...wh];
}

describe("ExitWriteService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDeps() {
    return {
      mockDispatch: { emit: jest.fn().mockResolvedValue(undefined) },
      mockAutomation: { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) },
      mockHrAutomation: { emit: jest.fn().mockResolvedValue(undefined) },
      mockResignationJobs: { notifyResignationSubmitted: jest.fn(), notifyHrApproved: jest.fn(), notifyFinalDecision: jest.fn() },
      mockExitChecklist: {
        seedForResignation: jest.fn().mockResolvedValue(undefined),
        addCustomItems: jest.fn().mockResolvedValue({ created: 0 }),
      },
      mockPolicyEval: { evaluatePolicy: jest.fn().mockResolvedValue(null) },
      mockCompletionGuard: { assertReady: jest.fn().mockResolvedValue(undefined) },
      mockAccess: { membersWithPermission: jest.fn().mockResolvedValue([]), resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) },
    };
  }

  it("returns NotFoundException for cross-tenant resignation update (cross-tenant isolation)", async () => {
    const { db, findFirst, where } = makeDb([]);
    const { mockDispatch, mockAutomation, mockHrAutomation, mockResignationJobs, mockExitChecklist, mockPolicyEval, mockCompletionGuard, mockAccess } = makeDeps();
    const svc = new ExitWriteService(db, mockDispatch as never, mockAutomation as never, mockHrAutomation as never, mockResignationJobs as never, mockExitChecklist as never, mockPolicyEval as never, mockCompletionGuard as never, mockAccess as never);
    const actor = { userId: "u1", membershipId: 1, role: "MEMBER", isApprover: false };
    await expect(svc.update(ATTACKER, actor, 999, {})).rejects.toThrow(NotFoundException);
    expect(allQueryArgs(findFirst, where)).toContain(ATTACKER);
  });

  it("finds resignation in owning org for update (control — same-tenant access works)", async () => {
    const ROW = { id: 1, orgId: OWNER, userId: "u1", status: "PENDING_HR", rowVersion: 1, lastWorkingDate: null, noticePeriodDays: 30, createdAt: new Date() };
    const { db, findFirst, where } = makeDb([ROW]);
    const { mockDispatch, mockAutomation, mockHrAutomation, mockResignationJobs, mockExitChecklist, mockPolicyEval, mockCompletionGuard, mockAccess } = makeDeps();
    const svc = new ExitWriteService(db, mockDispatch as never, mockAutomation as never, mockHrAutomation as never, mockResignationJobs as never, mockExitChecklist as never, mockPolicyEval as never, mockCompletionGuard as never, mockAccess as never);
    const actor = { userId: "u1", membershipId: 1, role: "MEMBER", isApprover: false };
    await expect(svc.update(OWNER, actor, 1, {})).resolves.toBeDefined();
    expect(allQueryArgs(findFirst, where)).toContain(OWNER);
  });

  it("scopes resignation creation check to org (cross-tenant isolation — existing check uses orgId)", async () => {
    const fakeRow = { id: 1, orgId: ATTACKER, userId: "actor-1", status: "PENDING_HR", rowVersion: 1, lastWorkingDate: null, noticePeriodDays: 30, createdAt: new Date() };
    const { db, findFirst, where } = makeDb([fakeRow]);
    const { mockDispatch, mockAutomation, mockHrAutomation, mockResignationJobs, mockExitChecklist, mockPolicyEval, mockCompletionGuard, mockAccess } = makeDeps();
    const svc = new ExitWriteService(db, mockDispatch as never, mockAutomation as never, mockHrAutomation as never, mockResignationJobs as never, mockExitChecklist as never, mockPolicyEval as never, mockCompletionGuard as never, mockAccess as never);
    const input = { reason: "personal", lastWorkingDate: new Date(Date.now() + 86400_000 * 30).toISOString().slice(0, 10) };
    await expect(svc.create(ATTACKER, "actor-1", 1, input as never)).rejects.toThrow(ConflictException);
    expect(allQueryArgs(findFirst, where)).toContain(ATTACKER);
  });
});
