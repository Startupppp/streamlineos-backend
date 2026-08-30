import type { Db } from "../../db/drizzle.module";
import { DealsCompetitorsService } from "./deals-competitors.service";
import { DealsMeetingsService } from "./deals-meetings.service";
import { DealsStakeholdersService } from "./deals-stakeholders.service";
import { DealsCrudService } from "./deals-crud.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    where,
  };
  for (const m of ["orderBy", "limit", "offset", "groupBy", "having", "leftJoin", "innerJoin", "rightJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("DealsCompetitorsService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new DealsCompetitorsService(db);
    const result = await svc.list(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, dealId: 1, name: "Competitor" };
    const { db } = makeDb([row]);
    const svc = new DealsCompetitorsService(db);
    const result = await svc.list(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("DealsMeetingsService — cross-tenant isolation", () => {
  it("listMeetings: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new DealsMeetingsService(db);
    const result = await svc.listMeetings(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listMeetings: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, dealId: 1, title: "Q1 Review" };
    const { db } = makeDb([row]);
    const svc = new DealsMeetingsService(db);
    const result = await svc.listMeetings(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("DealsStakeholdersService — cross-tenant isolation", () => {
  it("listStakeholders: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new DealsStakeholdersService(db);
    const result = await svc.listStakeholders(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listStakeholders: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, dealId: 1, role: "decision_maker" };
    const { db } = makeDb([row]);
    const svc = new DealsStakeholdersService(db);
    const result = await svc.listStakeholders(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("DealsCrudService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const cache = {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const crmValidation = { evaluate: jest.fn().mockResolvedValue({ passed: true }) };
    const bus = { emit: jest.fn().mockResolvedValue(undefined) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    return new DealsCrudService(db, cache as never, audit as never, crmValidation as never, bus as never, planLimits as never);
  }

  it("getDeal: returns undefined for a deal in a different org (cross-tenant isolation deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { deals: { findFirst } } } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.getDeal(ATTACKER, 999);
    expect(result).toBeUndefined();
    expect(findFirst).toHaveBeenCalled();
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("getDeal: returns the deal for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, title: "Deal1", stage: "open", value: 1000, assignedTo: null, lead: null, client: null };
    const findFirst = jest.fn().mockResolvedValue(row);
    const db = { query: { deals: { findFirst } } } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.getDeal(OWNER, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
