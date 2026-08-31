import type { Db } from "../../db/drizzle.module";
import { CrmConsentService } from "./consent/crm-consent.service";
import { CrmPricebooksService } from "./pricebooks/crm-pricebooks.service";

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
  for (const m of ["orderBy", "limit", "offset", "groupBy", "having", "leftJoin", "innerJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("CrmConsentService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return new CrmConsentService(db, audit as never);
  }

  it("filterSendable: returns all as blocked for empty contact list (deny — no cross-org data exposed)", async () => {
    const { db } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.filterSendable(ATTACKER, "EMAIL", []);
    expect(result.sendable).toHaveLength(0);
  });

  it("filterSendable: queries scoped to attacker org (deny — only attacker org's consent records)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.filterSendable(ATTACKER, "EMAIL", [1, 2]);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("filterSendable: queries scoped to owner org (control)", async () => {
    const row = { contactId: 1, status: "opted_in", expiresAt: null };
    const { db, where } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.filterSendable(OWNER, "EMAIL", [1]);
    expect(result.sendable).toHaveLength(1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmPricebooksService — cross-tenant isolation", () => {
  it("listPricebooks: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmPricebooksService(db);
    const result = await svc.listPricebooks(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listPricebooks: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Standard" };
    const { db } = makeDb([row]);
    const svc = new CrmPricebooksService(db);
    const result = await svc.listPricebooks(OWNER);
    expect(result).toHaveLength(1);
  });
});
