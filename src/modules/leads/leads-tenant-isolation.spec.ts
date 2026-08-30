import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { LeadsService } from "./leads.service";
import { LeadsReadService } from "./leads-read.service";
import { LeadConversionService } from "./lead-conversion.service";
import { LeadStatusService } from "./lead-status.service";
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
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("LeadsExportsService — cross-tenant isolation", () => {
  it("getDuplicates: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new LeadsExportsService(db);
    const result = await svc.getDuplicates(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getDuplicates: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Lead1" };
    const { db } = makeDb([row]);
    const svc = new LeadsExportsService(db);
    const result = await svc.getDuplicates(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("LeadsBoardService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        LeadsBoardService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: "CacheService",
          useValue: {
            cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
            cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
          },
        },
      ],
    }).compile();
    return mod.get(LeadsBoardService);
  }

  it("getBoard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.getBoard(ATTACKER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getBoard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.getBoard(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("LeadsReadService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        LeadsReadService,
        { provide: DRIZZLE, useValue: db },
        { provide: "LeadsBoardService", useValue: { getBoard: jest.fn().mockResolvedValue({ stages: [] }) } },
      ],
    }).compile();
    return mod.get(LeadsReadService);
  }

  it("list: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.list(ATTACKER, {});
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: queries scoped to owner org (control)", async () => {
    const row = { id: 1, orgId: OWNER };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.list(OWNER, {});
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("LeadsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: DRIZZLE, useValue: db },
        { provide: "LeadsReadService", useValue: { list: jest.fn().mockResolvedValue({ items: [], total: 0 }) } },
        { provide: "LeadsBoardService", useValue: { getBoard: jest.fn().mockResolvedValue({ stages: [] }) } },
        { provide: "CrmAutomationBusService", useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: "PlanLimitsService", useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: "AccessService", useValue: { resolveUserPermissions: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    return mod.get(LeadsService);
  }

  it("get: returns NotFoundException for a lead in a different org (deny — cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = await buildSvc(db);
    await expect(svc.get(ATTACKER, 999)).rejects.toThrow(NotFoundException);
  });

  it("get: returns the lead for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, title: "Lead1", stageId: 1 };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.get(OWNER, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("LeadConversionService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        LeadConversionService,
        { provide: DRIZZLE, useValue: db },
        { provide: "AccessService", useValue: { resolveUserPermissions: jest.fn().mockResolvedValue({}) } },
        { provide: "NotificationDispatchService", useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: "PartyMergeService", useValue: { merge: jest.fn().mockResolvedValue({ partyId: 1 }) } },
      ],
    }).compile();
    return mod.get(LeadConversionService);
  }

  it("convert: throws NotFoundException for a lead in a different org (cross-tenant deny)", async () => {
    const { db } = makeDb([]);
    const svc = await buildSvc(db);
    await expect(svc.convert(ATTACKER, 999, "user-1", {})).rejects.toThrow(NotFoundException);
  });

  it("convert: processes conversion for the owning org (control)", async () => {
    const lead = { id: 1, orgId: OWNER, title: "Lead", stageId: 1, contactId: null };
    const { db } = makeDb([lead]);
    const svc = await buildSvc(db);
    await expect(svc.convert(OWNER, 1, "user-1", {})).resolves.not.toThrow();
  });
});

describe("LeadStatusService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        LeadStatusService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CrmAutomationBusService", useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: "NotificationDispatchService", useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: "CrmMetadataService", useValue: { listPipelines: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();
    return mod.get(LeadStatusService);
  }

  it("move: throws NotFoundException for a lead in a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = await buildSvc(db);
    await expect(svc.move(ATTACKER, 999, 1, "user-1")).rejects.toThrow(NotFoundException);
  });

  it("move: processes the status move for the owning org (control)", async () => {
    const lead = { id: 1, orgId: OWNER, stageId: 1 };
    const stage = { id: 2, pipelineId: 1 };
    const { db } = makeDb([lead, stage]);
    const svc = await buildSvc(db);
    await expect(svc.move(OWNER, 1, 2, "user-1")).resolves.not.toThrow();
  });
});
