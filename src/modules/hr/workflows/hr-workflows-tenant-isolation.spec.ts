import type { Db } from "../../../db/drizzle.module";
import { HrWorkflowDefinitionsService } from "./hr-workflow-definitions.service";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { HrWorkflowDelegationsService } from "./hr-workflow-delegations.service";

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
  const countRow = [{ total: rows.length }];
  const dataBuilder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  dataBuilder.from.mockReturnValue(dataBuilder);
  dataBuilder.where.mockReturnValue(dataBuilder);
  dataBuilder.orderBy.mockReturnValue(dataBuilder);
  dataBuilder.limit.mockReturnValue(dataBuilder);
  dataBuilder.offset.mockReturnValue(dataBuilder);
  dataBuilder.leftJoin.mockReturnValue(dataBuilder);
  dataBuilder.innerJoin.mockReturnValue(dataBuilder);
  dataBuilder.groupBy.mockReturnValue(dataBuilder);
  const countBuilder = {
    from: jest.fn(), where: jest.fn(), orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(countRow).then(resolve),
  };
  countBuilder.from.mockReturnValue(countBuilder);
  countBuilder.where.mockReturnValue(countBuilder);
  countBuilder.orderBy.mockReturnValue(countBuilder);
  countBuilder.limit.mockReturnValue(countBuilder);
  countBuilder.offset.mockReturnValue(countBuilder);
  countBuilder.leftJoin.mockReturnValue(countBuilder);
  countBuilder.innerJoin.mockReturnValue(countBuilder);
  countBuilder.groupBy.mockReturnValue(countBuilder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const select = jest.fn().mockReturnValueOnce(dataBuilder).mockReturnValue(countBuilder);
  const db = {
    select,
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(dataBuilder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrWorkflowDefinitionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, status: "active" };

  it("scopes workflow definitions to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockEngine = { getInstanceTimeline: jest.fn() };
    const svc = new HrWorkflowDefinitionsService(db, mockEngine as never, {} as never);
    await svc.list(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns workflow definitions for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockEngine = { getInstanceTimeline: jest.fn() };
    const svc = new HrWorkflowDefinitionsService(db, mockEngine as never, {} as never);
    await svc.list(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrWorkflowInstancesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, status: "pending" };

  it("scopes workflow instances to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockEngine = { getInstanceTimeline: jest.fn() };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) };
    const mockEmployment = { getFactsBatch: jest.fn().mockResolvedValue([]) };
    const svc = new HrWorkflowInstancesService(db, mockEngine as never, mockAccess as never, mockEmployment as never);
    await svc.listForDefinition(ATTACKER, 1, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns workflow instances for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockEngine = { getInstanceTimeline: jest.fn() };
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) };
    const mockEmployment = { getFactsBatch: jest.fn().mockResolvedValue([]) };
    const svc = new HrWorkflowInstancesService(db, mockEngine as never, mockAccess as never, mockEmployment as never);
    await svc.listForDefinition(OWNER, 1, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrWorkflowDelegationsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, delegatorId: "u1", delegateeId: "u2" };

  it("scopes org delegations to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrWorkflowDelegationsService(db);
    await svc.orgDelegations(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns org delegations for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrWorkflowDelegationsService(db);
    await svc.orgDelegations(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
