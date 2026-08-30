import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CrmSequencesService } from "./automation-studio/crm-sequences.service";
import { CrmAutomationBusService } from "./automation-studio/crm-automation-bus.service";
import { CrmAutomationRunnerService } from "./automation-studio/crm-automation-runner.service";
import { CrmSequencesRunnerService } from "./automation-studio/crm-sequences-runner.service";

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

describe("CrmSequencesService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmSequencesService(db);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Seq1" };
    const { db } = makeDb([row]);
    const svc = new CrmSequencesService(db);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmAutomationBusService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmAutomationBusService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CrmAutomationRunnerService", useValue: { executeRule: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmAutomationBusService);
  }

  it("emit: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.emit(ATTACKER, "lead.created", { leadId: 1 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("emit: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.emit(OWNER, "lead.created", { leadId: 1 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmAutomationRunnerService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmAutomationRunnerService,
        { provide: DRIZZLE, useValue: db },
        { provide: "NotificationDispatchService", useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmAutomationRunnerService);
  }

  it("executeRule: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.executeRule(ATTACKER, 1, { leadId: 1 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("executeRule: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.executeRule(OWNER, 1, { leadId: 1 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmSequencesRunnerService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: db },
        { provide: "EmailService", useValue: { send: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmSequencesRunnerService);
  }

  it("runStep: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.runStep(ATTACKER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("runStep: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    await svc.runStep(OWNER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
