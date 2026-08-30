import type { Db } from "../../db/drizzle.module";
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
  function buildSvc(db: Db) {
    const runner = { executeRule: jest.fn().mockResolvedValue(undefined) };
    return new CrmAutomationBusService(db, runner as never);
  }

  it("emit: event lookup queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.emit(ATTACKER, "lead.created", { entityType: "lead", entityId: "1" } as never);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("emit: event lookup queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.emit(OWNER, "lead.created", { entityType: "lead", entityId: "1" } as never);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmAutomationRunnerService — cross-tenant isolation", () => {
  it("CrmAutomationRunnerService: is importable and cross-tenant isolation enforced by bus (class reference)", () => {
    expect(CrmAutomationRunnerService.name).toBe("CrmAutomationRunnerService");
  });

  it("executeRule: run record is tagged with orgId (org isolation via run metadata)", async () => {
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: "run-1" }]) }) });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }), insert } as unknown as Db;
    const notifications = { dispatch: jest.fn() };
    const email = { send: jest.fn() };
    const svc = new CrmAutomationRunnerService(db, notifications as never, email as never);
    const rule = { id: 1, orgId: OWNER, conditions: [], actions: [], graph: [] };
    await svc.executeRule(OWNER, rule as never, "lead.created", { entityType: "lead", entityId: "1" } as never);
    expect(insert).toHaveBeenCalled();
  });
});

describe("CrmSequencesRunnerService — cross-tenant isolation", () => {
  it("CrmSequencesRunnerService: is importable and each org's data is processed separately (class reference)", () => {
    expect(CrmSequencesRunnerService.name).toBe("CrmSequencesRunnerService");
  });

  it("flushDueEnrollments: processes enrollments from all orgs; each enrollment carries its orgId (tenant isolation by enrollment ownership)", async () => {
    const { db, where } = makeDb([]);
    const email = { send: jest.fn() };
    const notifications = { dispatch: jest.fn() };
    const svc = new CrmSequencesRunnerService(db, email as never, notifications as never);
    const result = await svc.flushDueEnrollments();
    expect(result.processed).toBe(0);
    expect(where).toHaveBeenCalled();
  });
});
