import type { Db, TenantTx } from "../../../db/drizzle.types";
import { LoanRecoveryService } from "./loan-recovery.service";
import { RunDataLoaderService } from "./run-data-loader.service";
import { RunResultPersisterService } from "./run-result-persister.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

function makeSelectChain(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    limit: jest.fn(),
    orderBy: jest.fn(),
    innerJoin: jest.fn(),
  };
  chain.limit.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  return where;
}

describe("LoanRecoveryService — cross-tenant isolation", () => {
  it("postPayrollLock: where clause carries attacker orgId when passed an external tx (deny — scoped to org)", async () => {
    const where = makeSelectChain([]);
    const tx = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as TenantTx;
    const db = { transaction: jest.fn() } as unknown as Db;
    const svc = new LoanRecoveryService(db);
    await svc.postPayrollLock(ATTACKER, 1, tx);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("postPayrollLock: where clause carries owner orgId for a legitimate run (control)", async () => {
    const where = makeSelectChain([]);
    const tx = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as TenantTx;
    const db = { transaction: jest.fn() } as unknown as Db;
    const svc = new LoanRecoveryService(db);
    await svc.postPayrollLock(OWNER, 1, tx);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});

describe("RunDataLoaderService — cross-tenant isolation", () => {
  it("loadPolicy: where clause carries attacker orgId — policy not returned for wrong org (deny)", async () => {
    const where = makeSelectChain([]);
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) }),
    } as unknown as Db;
    const svc = new RunDataLoaderService(db);
    const result = await svc.loadPolicy(ATTACKER, null);
    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    const vals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("loadPolicy: returns a policy version for the owning org (control)", async () => {
    const policyVersion = {
      id: 7,
      toggles: {},
      config: {},
      policyId: 1,
      status: "ACTIVE",
    };
    const where = makeSelectChain([policyVersion]);
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) }),
    } as unknown as Db;
    const svc = new RunDataLoaderService(db);
    const result = await svc.loadPolicy(OWNER, 7);
    expect(result).not.toBeNull();
    expect(result?.policyVersionId).toBe(7);
    const vals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(vals).toContain(OWNER);
  });
});

describe("RunResultPersisterService — cross-tenant isolation", () => {
  it("persistRunResults: payrollRuns update where clause carries orgId (deny — cross-tenant update blocked)", async () => {
    const runUpdateWhere = jest.fn().mockResolvedValue([]);
    const exceptionsCountThen = jest.fn((fn: (v: unknown[]) => unknown) => Promise.resolve([{ total: 0 }]).then(fn));
    const tx = {
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: runUpdateWhere }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            then: exceptionsCountThen,
            limit: jest.fn().mockReturnValue({ then: exceptionsCountThen }),
          }),
        }),
      }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const svc = new RunResultPersisterService(db);
    await svc.persistRunResults({
      orgId: ATTACKER,
      runId: 1,
      actorId: "actor",
      isRecalc: false,
      calcResults: [],
      totals: { grossTotalPaise: 0, deductionTotalPaise: 0, employerCostTotalPaise: 0, netTotalPaise: 0, processedCount: 0 },
      policyVersionId: 1,
      statutoryRuleVersion: null,
      month: "2025-01",
    });
    expect(runUpdateWhere).toHaveBeenCalled();
    const vals = sqlValues(runUpdateWhere.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("persistRunResults: payrollRuns update where clause carries owner orgId (control)", async () => {
    const runUpdateWhere = jest.fn().mockResolvedValue([]);
    const exceptionsCountThen = jest.fn((fn: (v: unknown[]) => unknown) => Promise.resolve([{ total: 0 }]).then(fn));
    const tx = {
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: runUpdateWhere }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            then: exceptionsCountThen,
            limit: jest.fn().mockReturnValue({ then: exceptionsCountThen }),
          }),
        }),
      }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const svc = new RunResultPersisterService(db);
    const result = await svc.persistRunResults({
      orgId: OWNER,
      runId: 2,
      actorId: "actor",
      isRecalc: false,
      calcResults: [],
      totals: { grossTotalPaise: 0, deductionTotalPaise: 0, employerCostTotalPaise: 0, netTotalPaise: 0, processedCount: 0 },
      policyVersionId: 1,
      statutoryRuleVersion: null,
      month: "2025-01",
    });
    expect(result.finalExceptionCount).toBe(0);
    const vals = sqlValues(runUpdateWhere.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});
