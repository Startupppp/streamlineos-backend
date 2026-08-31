import type { Db } from "../../../db/drizzle.module";
import { EpicsService } from "./epics.service";
import { CyclesService } from "./cycles.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

describe("EpicsService — cross-tenant isolation", () => {
  it("listEpics scopes findMany WHERE to the requesting org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { tickets: { findMany } } } as unknown as Db;
    const svc = new EpicsService(db);

    const result = await svc.listEpics(ATTACKER_ORG, 1);

    expect(findMany).toHaveBeenCalled();
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(opts?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(opts?.where)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listEpics returns epics for the owning org (control — same-tenant access works)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic 1", type: "EPIC" };
    const db = { query: { tickets: { findMany: jest.fn().mockResolvedValue([fakeEpic]) } } } as unknown as Db;
    const svc = new EpicsService(db);

    const result = await svc.listEpics(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});

describe("CyclesService — cross-tenant isolation", () => {
  it("listCycles scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    const result = await svc.listCycles(ATTACKER_ORG, 1, {});

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listCycles returns cycles for the owning org (control — same-tenant access works)", async () => {
    const fakeCycle = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Sprint 1", status: "ACTIVE" };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeCycle]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    const result = await svc.listCycles(OWNER_ORG, 1, {});
    expect(result).toHaveLength(1);
  });
});
