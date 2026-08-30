import { Test } from "@nestjs/testing";
import type { Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CrmBlueprintsService } from "./crm-blueprints.service";
import { CrmDataQualityService } from "./crm-data-quality.service";
import { CrmValidationService } from "./crm-validation.service";
import { CrmMetadataService } from "./crm-metadata.service";
import { CrmValidationRulesService } from "./crm-validation-rules.service";

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

describe("CrmBlueprintsService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmBlueprintsService(db);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "BP1" };
    const { db } = makeDb([row]);
    const svc = new CrmBlueprintsService(db);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmDataQualityService — cross-tenant isolation", () => {
  it("getReport: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmDataQualityService(db);
    const result = await svc.getReport(ATTACKER);
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getReport: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmDataQualityService(db);
    await svc.getReport(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmValidationService — cross-tenant isolation", () => {
  it("evaluate: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmValidationService(db);
    const result = await svc.evaluate(ATTACKER, "lead", {});
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("evaluate: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmValidationService(db);
    await svc.evaluate(OWNER, "lead", {});
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmValidationRulesService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmValidationRulesService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CrmValidationService", useValue: { evaluate: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    return mod.get(CrmValidationRulesService);
  }

  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Rule1" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmMetadataService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmMetadataService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: "CacheService",
          useValue: {
            cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
            cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
          },
        },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmMetadataService);
  }

  it("listPipelines: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listPipelines(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listPipelines: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "P1", stages: [] };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.listPipelines(OWNER);
    expect(result).toHaveLength(1);
  });
});
