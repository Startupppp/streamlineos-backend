import type { Db } from "../../../db/drizzle.module";
import { HrInterviewsService } from "./hr-interviews.service";
import { HrHiringFlowsService } from "./hr-hiring-flows.service";
import { HrScorecardsService } from "./hr-scorecards.service";
import { HrOffersService } from "./hr-offers.service";

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
  const findFirstRef = findFirst;
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
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst: findFirstRef };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock, findFirst?: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  if (findFirst && findFirst.mock.calls.length > 0) return (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

const mockConfig = { app: { url: "https://app.test" } };

describe("HrInterviewsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, panelMembers: [] };

  it("scopes interview list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrInterviewsService(db, mockConfig as never);
    await svc.list(ATTACKER, { page: 1, pageSize: 10, limit: 10, offset: 0, candidateId: undefined, upcoming: undefined, relevant: undefined });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns interviews for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrInterviewsService(db, mockConfig as never);
    await svc.list(OWNER, { page: 1, pageSize: 10, limit: 10, offset: 0, candidateId: undefined, upcoming: undefined, relevant: undefined });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrHiringFlowsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, rounds: [] };

  it("throws NotFoundException for cross-tenant hiring flow access (cross-tenant isolation)", async () => {
    const { db, where, findMany, findFirst } = makeDb([]);
    const mockCache = { cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()), invalidateNamespace: jest.fn() };
    const svc = new HrHiringFlowsService(db, mockCache as never);
    await expect(svc.getFlow(ATTACKER, 999)).rejects.toThrow();
    expect(sqlValues(isolationArg(where, findMany, findFirst))).toContain(ATTACKER);
  });

  it("returns hiring flow for owning org (control)", async () => {
    const { db, where, findMany, findFirst } = makeDb([ROW]);
    const mockCache = { cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()), invalidateNamespace: jest.fn() };
    const svc = new HrHiringFlowsService(db, mockCache as never);
    await svc.getFlow(OWNER, 1);
    expect(sqlValues(isolationArg(where, findMany, findFirst))).toContain(OWNER);
  });
});

describe("HrScorecardsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("scopes scorecard templates to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrScorecardsService(db);
    await svc.listTemplates(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns scorecard templates for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrScorecardsService(db);
    await svc.listTemplates(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrOffersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("scopes offer templates to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrOffersService(db);
    await svc.listTemplates(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns offer templates for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrOffersService(db);
    await svc.listTemplates(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
