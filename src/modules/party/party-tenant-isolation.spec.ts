import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { PartyRolesService } from "./party-roles.service";
import { PartyDivergenceService } from "./party-divergence.service";
import { PartyMergeService } from "./party-merge.service";
import { SubjectService } from "./subject.service";

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
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue({ from }) } as unknown as Db)),
  } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("PartyRolesService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        PartyRolesService,
        { provide: DRIZZLE, useValue: db },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: "PartyMergeService", useValue: { merge: jest.fn().mockResolvedValue({ partyId: 1 }) } },
      ],
    }).compile();
    return mod.get(PartyRolesService);
  }

  it("listRoles: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listRoles(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listRoles: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, partyId: 1, role: "buyer" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.listRoles(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("PartyDivergenceService — cross-tenant isolation", () => {
  it("report: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PartyDivergenceService(db);
    const result = await svc.report(ATTACKER);
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("report: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PartyDivergenceService(db);
    await svc.report(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("PartyMergeService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        PartyMergeService,
        { provide: DRIZZLE, useValue: db },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(PartyMergeService);
  }

  it("merge: queries scoped to attacker org (cross-tenant isolation deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.merge(ATTACKER, { survivorPartyId: 1, absorbedPartyId: 2 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("merge: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.merge(OWNER, { survivorPartyId: 1, absorbedPartyId: 2 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("SubjectService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        SubjectService,
        { provide: DRIZZLE, useValue: db },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(SubjectService);
  }

  it("listTypes: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listTypes(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listTypes: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Type1" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.listTypes(OWNER);
    expect(result).toHaveLength(1);
  });

  it("listSubjects: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listSubjects(ATTACKER, {});
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listSubjects: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Subject1" };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.listSubjects(OWNER, {});
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
