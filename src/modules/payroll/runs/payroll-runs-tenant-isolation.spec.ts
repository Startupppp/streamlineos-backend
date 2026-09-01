jest.mock("../../../common/tenant", () => ({
  withTenant: (_db: unknown, _opts: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  runWithTenantContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  forEachOrg: jest.fn().mockResolvedValue(undefined),
}));

import type { Db } from "../../../db/drizzle.module";
import { PayrollRunLockService } from "../run-lock.service";
import { CommandCenterService } from "./command-center.service";
import { RunBatchLoaderService } from "./run-batch-loader.service";
import { PayrollJobsService } from "../jobs/payroll-jobs.service";
import { PayrollJobsWorkerService } from "../jobs/payroll-jobs-worker.service";

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
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
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
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) });
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const db = {
    ...txDb,
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst, updateWhere };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock, updateWhere?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  const uw = updateWhere ? updateWhere.mock.calls.flatMap((c) => sqlValues(c[0])) : [];
  return [...wh, ...ff, ...fm, ...uw];
}

describe("PayrollRunLockService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes lock acquire to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany, updateWhere } = makeDb([]);
    const svc = new PayrollRunLockService(db);
    await expect(svc.acquire(ATTACKER, 999)).rejects.toThrow();
    expect(allArgs(where, findFirst, findMany, updateWhere)).toContain(ATTACKER);
  });

  it("scopes lock acquire to owner org (control — same-tenant acquire works)", async () => {
    let capturedToken: string | null = null;
    const returning = jest.fn().mockImplementation(() => Promise.resolve([{ id: 999, generationLockToken: capturedToken }]));
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockImplementation((vals: Record<string, unknown>) => {
      capturedToken = vals["generationLockToken"] as string;
      return { where: updateWhere };
    });
    const { db } = makeDb([]);
    const dbWithCapture = { ...db, update: jest.fn().mockReturnValue({ set: updateSet }) } as unknown as Db;
    const svc = new PayrollRunLockService(dbWithCapture);
    const token = await svc.acquire(OWNER, 999);
    expect(typeof token).toBe("string");
    expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(OWNER);
  });

  it("scopes assertNoOtherActiveGeneration to org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollRunLockService(db);
    await svc.assertNoOtherActiveGeneration(ATTACKER, "2024-01", 1);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("CommandCenterService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes command center run lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockRunsService = {
      buildVarianceSummary: jest.fn().mockResolvedValue({}),
    };
    const svc = new CommandCenterService(db, mockRunsService as never);
    await svc.getCommandCenter(ATTACKER, { month: "2024-01" });
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes command center run lookup to owner org (control — same-tenant returns data)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockRunsService = {
      buildVarianceSummary: jest.fn().mockResolvedValue({}),
    };
    const svc = new CommandCenterService(db, mockRunsService as never);
    await svc.getCommandCenter(OWNER, { month: "2024-01" });
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("RunBatchLoaderService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes batch load to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new RunBatchLoaderService(db);
    const profile = { id: 1, userId: "u1", workerId: null, workerType: "EMPLOYEE" as const, currency: "INR", payoutCurrency: null, annualCtc: "0", taxRegime: null };
    await svc.loadRunBatchData(ATTACKER, 999, "2024-01", {} as never, [profile], null);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes batch load to owner org (control — same-tenant returns empty batch)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new RunBatchLoaderService(db);
    const profile = { id: 1, userId: "u1", workerId: null, workerType: "EMPLOYEE" as const, currency: "INR", payoutCurrency: null, annualCtc: "0", taxRegime: null };
    await svc.loadRunBatchData(OWNER, 1, "2024-01", {} as never, [profile], null);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("PayrollJobsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes job enqueue to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.enqueue({ orgId: ATTACKER, idempotencyKey: "k1", jobType: "GENERATE", actorId: "u1", payload: {} });
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes job enqueue to owner org (control — same-tenant creates job)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.enqueue({ orgId: OWNER, idempotencyKey: "k2", jobType: "GENERATE", actorId: "u2", payload: {} });
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes listFailed to org (cross-tenant isolation — failed list checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.listFailed(ATTACKER, undefined);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("PayrollJobsWorkerService — cross-tenant isolation", () => {
  it("flush uses forEachOrg so org scope is DB-driven, not client-supplied (cross-tenant isolation)", async () => {
    const { forEachOrg } = jest.requireMock("../../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockResolvedValue(undefined);
    const { db } = makeDb([]);
    const mockJobs = { setProgress: jest.fn(), succeed: jest.fn(), fail: jest.fn(), markRunning: jest.fn(), listFailed: jest.fn().mockResolvedValue([]) };
    const mockModuleRef = { get: jest.fn().mockReturnValue(undefined) };
    const svc = new PayrollJobsWorkerService(mockJobs as never, mockModuleRef as never, db);
    const result = await svc.flush();
    expect(result.claimed).toBe(0);
    expect(forEachOrg).toHaveBeenCalled();
  });
});
