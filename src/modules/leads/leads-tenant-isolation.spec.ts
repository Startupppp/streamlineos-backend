import { ScopedRead } from "../access/scoped-read";
import type { Db } from "../../db/drizzle.module";
import { LeadsService } from "./leads.service";
import { LeadsReadService } from "./leads-read.service";
import { LeadsBoardService } from "./leads-board.service";
import { LeadsExportsService } from "./leads-exports.service";

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
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0]);
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    query: {
      crmPipelines: { findMany, findFirst },
      leadPartyMap: { findMany, findFirst },
    },
  } as unknown as Db;
  return { db, where };
}

function makeCache() {
  return {
    cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
    cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("LeadsExportsService — cross-tenant isolation", () => {
  it("getDuplicates: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new LeadsExportsService(db);
    const result = await svc.getDuplicates(ATTACKER);
    const r = result as Record<string, unknown>;
    const arr = (r.duplicates ?? r.groups ?? result) as unknown[];
    expect(arr).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getDuplicates: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Lead1" };
    const { db, where } = makeDb([row]);
    const svc = new LeadsExportsService(db);
    await svc.getDuplicates(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("LeadsBoardService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    return new LeadsBoardService(db, makeCache() as never);
  }

  it("getBoard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getBoard(ATTACKER, { read: ScopedRead.of(ATTACKER, "user-1", "all") });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getBoard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getBoard(OWNER, { read: ScopedRead.of(OWNER, "user-1", "all") });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("LeadsReadService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const boardService = { getBoard: jest.fn().mockResolvedValue({ stages: [] }) };
    return new LeadsReadService(db, boardService as never);
  }

  it("listLeads: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.listLeads(ATTACKER, { read: ScopedRead.of(ATTACKER, "user-1", "all") });
    const r = result as Record<string, unknown>;
    const arr = (r.leads ?? r.items ?? result) as unknown[];
    expect(arr).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listLeads: queries scoped to owner org (control)", async () => {
    const row = { id: 1, orgId: OWNER };
    const { db, where } = makeDb([row]);
    const svc = buildSvc(db);
    await svc.listLeads(OWNER, { read: ScopedRead.of(OWNER, "user-1", "all") });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("LeadsService — cross-tenant isolation", () => {
  it("getLead: returns undefined for a lead in a different org (cross-tenant isolation deny)", async () => {
    const reads = { getLead: jest.fn().mockResolvedValue(undefined) };
    const cache = makeCache();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const automation = { trigger: jest.fn().mockResolvedValue(undefined) };
    const webhooksDispatch = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const crmValidation = { evaluate: jest.fn().mockResolvedValue({ passed: true }) };
    const bus = { emit: jest.fn().mockResolvedValue(undefined) };
    const attribution = { track: jest.fn() };
    const territoryMatch = { match: jest.fn().mockResolvedValue(null) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const { db } = makeDb([]);
    const svc = new LeadsService(db, cache as never, audit as never, dispatch as never, automation as never, webhooksDispatch as never, crmValidation as never, bus as never, attribution as never, territoryMatch as never, reads as never, planLimits as never);
    const result = await svc.getLead(ATTACKER, 999);
    expect(result).toBeUndefined();
    expect(reads.getLead).toHaveBeenCalledWith(ATTACKER, 999);
  });

  it("getLead: returns the lead for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, title: "Lead1", status: "open", stageId: 1 };
    const reads = { getLead: jest.fn().mockResolvedValue(row) };
    const cache = makeCache();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const automation = { trigger: jest.fn().mockResolvedValue(undefined) };
    const webhooksDispatch = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const crmValidation = { evaluate: jest.fn().mockResolvedValue({ passed: true }) };
    const bus = { emit: jest.fn().mockResolvedValue(undefined) };
    const attribution = { track: jest.fn() };
    const territoryMatch = { match: jest.fn().mockResolvedValue(null) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const { db } = makeDb([row]);
    const svc = new LeadsService(db, cache as never, audit as never, dispatch as never, automation as never, webhooksDispatch as never, crmValidation as never, bus as never, attribution as never, territoryMatch as never, reads as never, planLimits as never);
    const result = await svc.getLead(OWNER, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
