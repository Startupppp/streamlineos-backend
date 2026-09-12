import { NotFoundException } from "@nestjs/common";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
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

function makeChainDb(rows: unknown[]): { db: Db; where: jest.Mock } {
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
  it("list: throws NotFoundException for a deal in a different org (cross-tenant isolation deny)", async () => {
    const { db, where } = makeChainDb([]);
    const svc = new DealsCompetitorsService(db);
    await expect(svc.list(ATTACKER, 999)).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, dealId: 1, name: "Competitor" };
    const { db } = makeChainDb([row]);
    const svc = new DealsCompetitorsService(db);
    const result = await svc.list(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("DealsMeetingsService — cross-tenant isolation", () => {
  it("listMeetings: throws NotFoundException for a deal in a different org (deny)", async () => {
    const dealsNotFound = jest.fn().mockResolvedValue(undefined);
    const db = {
      select: jest.fn(),
      query: {
        deals: { findFirst: dealsNotFound },
        dealMeetings: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new DealsMeetingsService(db);
    await expect(svc.listMeetings(ATTACKER, 999)).rejects.toThrow(NotFoundException);
    expect(dealsNotFound).toHaveBeenCalled();
    expect(sqlValues(dealsNotFound.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("listMeetings: returns rows for the owning org (control)", async () => {
    const dealRow = { id: 1 };
    const meetingRow = { id: 10, dealId: 1, orgId: OWNER, scheduledAt: new Date(), creator: { id: "u1", name: "User" } };
    const dealsFound = jest.fn().mockResolvedValue(dealRow);
    const meetingsFound = jest.fn().mockResolvedValue([meetingRow]);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            then: (fn: (v: unknown) => unknown) => Promise.resolve([{ meetingId: 10, attendeeId: "u1" }]).then(fn),
            catch: (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn),
            finally: (fn: () => void) => Promise.resolve([]).finally(fn),
            inArray: jest.fn(),
          }),
          inArray: jest.fn().mockResolvedValue([]),
        }),
      }),
      query: {
        deals: { findFirst: dealsFound },
        dealMeetings: { findMany: meetingsFound },
      },
    } as unknown as Db;
    const svc = new DealsMeetingsService(db);
    const result = await svc.listMeetings(OWNER, 1);
    expect(result).toHaveLength(1);
    expect(dealsFound).toHaveBeenCalled();
    expect(sqlValues(dealsFound.mock.calls[0]?.[0]?.where)).toContain(OWNER);
  });
});

describe("DealsStakeholdersService — cross-tenant isolation", () => {
  it("listStakeholders: throws NotFoundException for a deal in a different org (deny)", async () => {
    const dealsNotFound = jest.fn().mockResolvedValue(undefined);
    const db = {
      select: jest.fn(),
      query: { deals: { findFirst: dealsNotFound } },
    } as unknown as Db;
    const svc = new DealsStakeholdersService(db);
    await expect(svc.listStakeholders(ATTACKER, 999)).rejects.toThrow(NotFoundException);
    expect(dealsNotFound).toHaveBeenCalled();
    expect(sqlValues(dealsNotFound.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("listStakeholders: returns rows for the owning org (control)", async () => {
    const dealRow = { id: 1 };
    const stakeRow = { id: 5, dealId: 1 };
    const dealsFound = jest.fn().mockResolvedValue(dealRow);
    const chain: Record<string, unknown> = {
      then: (fn: (v: unknown) => unknown) => Promise.resolve([stakeRow]).then(fn),
      catch: (fn: (e: unknown) => unknown) => Promise.resolve([stakeRow]).catch(fn),
      finally: (fn: () => void) => Promise.resolve([stakeRow]).finally(fn),
    };
    for (const m of ["where", "orderBy", "limit", "leftJoin", "innerJoin"]) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(chain) }),
      query: { deals: { findFirst: dealsFound } },
    } as unknown as Db;
    const svc = new DealsStakeholdersService(db);
    const result = await svc.listStakeholders(OWNER, 1);
    expect(result).toHaveLength(1);
    expect(dealsFound).toHaveBeenCalled();
    expect(sqlValues(dealsFound.mock.calls[0]?.[0]?.where)).toContain(OWNER);
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
    const result = await svc.getDeal(ScopedRead.of(ATTACKER, "user-attacker", "all"), 999);
    expect(result).toBeUndefined();
    expect(findFirst).toHaveBeenCalled();
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("getDeal: returns the deal for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, title: "Deal1", stage: "open", value: 1000, assignedTo: null, lead: null, client: null };
    const findFirst = jest.fn().mockResolvedValue(row);
    const db = { query: { deals: { findFirst } } } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.getDeal(ScopedRead.of(OWNER, "user-owner", "all"), 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

const dialect = new PgDialect();

function renderWhere(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL)) throw new Error("expected a SQL WHERE clause");
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

describe("DealsCrudService.getDeal — the DataScope reaches the detail query (BOLA)", () => {
  const ORG = "org-scope";
  const ME = "user-me";
  const SOMEONE_ELSE = "user-other";

  function buildSvc(db: Db) {
    const cache = {
      cached: jest.fn(),
      cachedVersioned: jest.fn(),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    return new DealsCrudService(
      db,
      cache as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  function captureWhere(row: unknown) {
    const findFirst = jest.fn().mockResolvedValue(row);
    const db = { query: { deals: { findFirst } } } as unknown as Db;
    return { svc: buildSvc(db), findFirst };
  }

  it("all scope: the emitted WHERE carries the tenant predicate and binds the caller's org", async () => {
    const { svc, findFirst } = captureWhere({ id: 7 });
    await svc.getDeal(ScopedRead.of(ORG, ME, "all"), 7);
    const { sql, params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
  });

  it("all scope: the WHERE does NOT bind the actor id — an unrestricted reader is not narrowed to their own deals", async () => {
    const { svc, findFirst } = captureWhere({ id: 7 });
    await svc.getDeal(ScopedRead.of(ORG, ME, "all"), 7);
    const { params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(params).not.toContain(ME);
  });

  it("own scope: the WHERE narrows on assigned_to_id and binds the caller's user id", async () => {
    const { svc, findFirst } = captureWhere(undefined);
    await svc.getDeal(ScopedRead.of(ORG, ME, "own"), 7);
    const { sql, params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(sql).toContain("assigned_to_id");
    expect(params).toContain(ME);
    expect(params).toContain(ORG);
  });

  it("own scope: the predicate binds the caller, never the other person — the id in the URL cannot widen it", async () => {
    const { svc, findFirst } = captureWhere(undefined);
    await svc.getDeal(ScopedRead.of(ORG, ME, "own"), 7);
    const { params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(params).not.toContain(SOMEONE_ELSE);
  });

  it("own scope renders a strictly different WHERE from all scope — proving the scope is spent, not dropped", async () => {
    const a = captureWhere({ id: 7 });
    await a.svc.getDeal(ScopedRead.of(ORG, ME, "all"), 7);
    const b = captureWhere(undefined);
    await b.svc.getDeal(ScopedRead.of(ORG, ME, "own"), 7);
    expect(renderWhere(a.findFirst.mock.calls[0]?.[0]?.where).sql).not.toBe(
      renderWhere(b.findFirst.mock.calls[0]?.[0]?.where).sql,
    );
  });

  it("own scope: a row the predicate excludes comes back undefined, which the controller turns into 404", async () => {
    const { svc } = captureWhere(undefined);
    await expect(svc.getDeal(ScopedRead.of(ORG, ME, "own"), 7)).resolves.toBeUndefined();
  });

  it("none scope: no query is issued at all", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 7 });
    const db = { query: { deals: { findFirst } } } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.getDeal(ScopedRead.of(ORG, ME, "none"), 7);
    expect(result).toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("the deal id is still bound — the scope predicate did not replace the domain filter", async () => {
    const { svc, findFirst } = captureWhere({ id: 4242 });
    await svc.getDeal(ScopedRead.of(ORG, ME, "all"), 4242);
    const { params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(params).toContain(4242);
  });
});
