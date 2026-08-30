import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
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
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmConsentService,
        { provide: DRIZZLE, useValue: db },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmConsentService);
  }

  it("filterSendable: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.filterSendable(ATTACKER, ["contact-1"]);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("filterSendable: returns rows for the owning org (control)", async () => {
    const row = { contactId: "c1", orgId: OWNER, consentStatus: "opted_in" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.filterSendable(OWNER, ["c1"]);
    expect(result).toHaveLength(1);
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
