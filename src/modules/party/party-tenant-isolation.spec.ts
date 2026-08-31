import type { Db } from "../../db/drizzle.module";
import { PartyRolesService } from "./party-roles.service";
import { PartyDivergenceService } from "./party-divergence.service";
import { PartyMergeService } from "./party-merge.service";
import { SubjectService } from "./subject.service";
import { SubjectTypeService } from "./subject-type.service";

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

describe("PartyRolesService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const merges = { merge: jest.fn().mockResolvedValue({ survivorPartyId: "p1" }) };
    return new PartyRolesService(db, audit as never, merges as never);
  }

  it("listRoles: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.listRoles(ATTACKER, "p1");
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listRoles: returns rows for the owning org (control)", async () => {
    const row = { role: "buyer" };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.listRoles(OWNER, "p1");
    expect(result).toHaveLength(1);
  });
});

describe("PartyDivergenceService — cross-tenant isolation", () => {
  it("report: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PartyDivergenceService(db);
    await svc.report(ATTACKER);
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
  function buildSvc(db: Db) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return new PartyMergeService(db, audit as never);
  }

  it("merge: load queries scoped to attacker org (cross-tenant isolation deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.merge(ATTACKER, { leftPartyId: "p1", rightPartyId: "p2", decidedBy: "SYSTEM" }).catch(() => {});
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("merge: load queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.merge(OWNER, { leftPartyId: "p1", rightPartyId: "p2", decidedBy: "SYSTEM" }).catch(() => {});
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("SubjectService — cross-tenant isolation", () => {
  function buildSubjectSvc(db: Db) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const types = new SubjectTypeService(db, audit as never);
    return new SubjectService(db, audit as never, types);
  }

  function buildTypeSvc(db: Db) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return new SubjectTypeService(db, audit as never);
  }

  it("listTypes: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildTypeSvc(db);
    const result = await svc.listTypes(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listTypes: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Type1" };
    const { db } = makeDb([row]);
    const svc = buildTypeSvc(db);
    const result = await svc.listTypes(OWNER);
    expect(result).toHaveLength(1);
  });

  it("listSubjects: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSubjectSvc(db);
    const result = await svc.listSubjects(ATTACKER, { limit: 20 } as never);
    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listSubjects: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Subject1", createdAt: new Date(), subjectId: "s1" };
    const { db, where } = makeDb([row, row]);
    const svc = buildSubjectSvc(db);
    const result = await svc.listSubjects(OWNER, { limit: 20 } as never);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
    expect(result.data.length).toBeGreaterThan(0);
  });
});
